import { describe, expect, it, vi } from "vitest";
import { createImagesRoutes } from "@src/routes/images.js";
import { createModelRoutes } from "@src/routes/models.js";

function imageResponse() {
  return new Response(JSON.stringify({
    created_at: 1_700_000_001,
    output: [{
      type: "image_generation_call",
      result: "aGVsbG8=",
      output_format: "png",
      revised_prompt: "A revised prompt",
      size: "1024x1024",
    }],
    tool_usage: { image_gen: { input_tokens: 2, output_tokens: 3, total_tokens: 5 } },
  }), { headers: { "Content-Type": "application/json" } });
}

describe("POST /v1/images/generations", () => {
  it("uses the direct Codex Images API for gpt-image-1.5 and preserves its response", async () => {
    const responsesFetch = vi.fn(async () => imageResponse());
    const directImagesFetch = vi.fn(async () => new Response(JSON.stringify({
      created: 1_700_000_002,
      data: [{ b64_json: "ZGlyZWN0" }],
    }), { headers: { "Content-Type": "application/json" } }));
    const app = createImagesRoutes(responsesFetch, { directImagesFetch });

    const res = await app.request("/v1/images/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-image-1.5", prompt: "Draw a cat", n: 2 }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ created: 1_700_000_002, data: [{ b64_json: "ZGlyZWN0" }] });
    expect(directImagesFetch).toHaveBeenCalledWith("generations", {
      model: "gpt-image-1.5",
      prompt: "Draw a cat",
      n: 2,
    }, expect.any(AbortSignal));
    expect(responsesFetch).not.toHaveBeenCalled();
  });

  it("falls back to the Responses image tool when the direct image-2 endpoint is unavailable", async () => {
    const responsesFetch = vi.fn(async () => imageResponse());
    const directImagesFetch = vi.fn(async () => new Response("not found", { status: 404 }));
    const app = createImagesRoutes(responsesFetch, { directImagesFetch });

    const res = await app.request("/v1/images/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-image-2", prompt: "Draw a cat" }),
    });

    expect(res.status).toBe(200);
    expect(directImagesFetch).toHaveBeenCalledOnce();
    expect(responsesFetch).toHaveBeenCalledOnce();
  });

  it("falls back for image-2 when the account group lacks native Images permission", async () => {
    const responsesFetch = vi.fn(async () => imageResponse());
    const directImagesFetch = vi.fn(async () => new Response(JSON.stringify({
      error: {
        message: "Image generation is not enabled for this group",
        type: "permission_error",
      },
    }), { status: 403, headers: { "Content-Type": "application/json" } }));
    const app = createImagesRoutes(responsesFetch, { directImagesFetch });

    const res = await app.request("/v1/images/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-image-2", prompt: "Draw a cat" }),
    });

    expect(res.status).toBe(200);
    expect(directImagesFetch).toHaveBeenCalledOnce();
    expect(responsesFetch).toHaveBeenCalledOnce();
  });

  it("translates a standard Images request to the Responses image tool", async () => {
    const responsesFetch = vi.fn(async () => imageResponse());
    const app = createImagesRoutes(responsesFetch);

    const res = await app.request("/v1/images/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer proxy-key" },
      body: JSON.stringify({
        model: "gpt-image-2",
        prompt: "Draw a cat",
        size: "1024x1024",
        output_format: "png",
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { created: number; data: Array<{ b64_json: string; revised_prompt: string }> };
    expect(body.created).toBe(1_700_000_001);
    expect(body.data[0]).toEqual({ b64_json: "aGVsbG8=", revised_prompt: "A revised prompt" });

    const delegated = responsesFetch.mock.calls[0][0] as Request;
    expect(delegated.headers.get("Authorization")).toBe("Bearer proxy-key");
    expect(await delegated.json()).toEqual({
      model: "gpt-5.4-mini",
      stream: false,
      input: [{ role: "user", content: "Draw a cat" }],
      tools: [{ type: "image_generation", size: "1024x1024", output_format: "png" }],
    });
  });

  it("supports response_format=url using a self-contained data URL", async () => {
    const app = createImagesRoutes(async () => imageResponse());
    const res = await app.request("/v1/images/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-image-2", prompt: "Draw a cat", response_format: "url" }),
    });
    const body = await res.json() as { data: Array<{ url: string }> };
    expect(body.data[0].url).toBe("data:image/png;base64,aGVsbG8=");
  });

  it("validates prompt, n, and model before delegation", async () => {
    const responsesFetch = vi.fn(async () => imageResponse());
    const app = createImagesRoutes(responsesFetch);
    for (const request of [
      { model: "gpt-image-2" },
      { model: "gpt-image-2", prompt: "x", n: 2 },
      { model: "other", prompt: "x" },
    ]) {
      const res = await app.request("/v1/images/generations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
      });
      expect(res.status).toBe(400);
    }
    expect(responsesFetch).not.toHaveBeenCalled();
  });

  it("translates Codex image events into Images API SSE events", async () => {
    const upstream = [
      "event: response.image_generation_call.partial_image\n",
      'data: {"type":"response.image_generation_call.partial_image","partial_image_b64":"cGFydGlhbA==","output_format":"png","partial_image_index":0}\n\n',
      "event: response.output_item.done\n",
      'data: {"type":"response.output_item.done","item":{"type":"image_generation_call","result":"ZmluYWw=","output_format":"webp","revised_prompt":"Final prompt"}}\n\n',
    ].join("");
    const responsesFetch = vi.fn(async () => new Response(upstream, {
      headers: { "Content-Type": "text/event-stream" },
    }));
    const app = createImagesRoutes(responsesFetch);
    const res = await app.request("/v1/images/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-image-2", prompt: "Draw a cat", stream: true, response_format: "url" }),
    });
    expect(res.headers.get("Content-Type")).toContain("text/event-stream");
    const stream = await res.text();
    expect(stream).toContain("event: image_generation.partial_image");
    expect(stream).toContain('"url":"data:image/png;base64,cGFydGlhbA=="');
    expect(stream).toContain("event: image_generation.completed");
    expect(stream).toContain('"url":"data:image/webp;base64,ZmluYWw="');
    expect(stream).toContain('"revised_prompt":"Final prompt"');
    expect(await (responsesFetch.mock.calls[0][0] as Request).json()).toMatchObject({ stream: true });
  });

  it("returns a useful error when a Free account produces no image item", async () => {
    const app = createImagesRoutes(async () => new Response(JSON.stringify({ output: [] })));
    const res = await app.request("/v1/images/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-image-2", prompt: "Draw a cat" }),
    });
    expect(res.status).toBe(502);
    const body = await res.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe("image_generation_failed");
    expect(body.error.message).toContain("Plus");
  });
});

describe("POST /v1/images/edits", () => {
  it("forwards reference images, masks, and n to the direct edits endpoint", async () => {
    const responsesFetch = vi.fn(async () => imageResponse());
    const directImagesFetch = vi.fn(async () => new Response(JSON.stringify({ data: [] }), {
      headers: { "Content-Type": "application/json" },
    }));
    const app = createImagesRoutes(responsesFetch, { directImagesFetch });
    const res = await app.request("/v1/images/edits", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-image-2",
        prompt: "Change this",
        n: 2,
        images: [{ image_url: "data:image/png;base64,aA==" }],
        mask: { image_url: "data:image/png;base64,bQ==" },
      }),
    });

    expect(res.status).toBe(200);
    expect(directImagesFetch).toHaveBeenCalledWith("edits", {
      model: "gpt-image-2",
      prompt: "Change this",
      n: 2,
      images: [{ image_url: "data:image/png;base64,aA==" }],
      mask: { image_url: "data:image/png;base64,bQ==" },
    }, expect.any(AbortSignal));
    expect(responsesFetch).not.toHaveBeenCalled();
  });

  it("accepts JSON reference images and forwards them as input_image parts", async () => {
    const responsesFetch = vi.fn(async () => imageResponse());
    const app = createImagesRoutes(responsesFetch);
    const res = await app.request("/v1/images/edits", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-image-2",
        prompt: "Make it sunset",
        images: [{ image_url: "https://example.com/source.png" }],
      }),
    });
    expect(res.status).toBe(200);
    expect(await (responsesFetch.mock.calls[0][0] as Request).json()).toMatchObject({
      input: [{ role: "user", content: [
        { type: "input_text", text: "Make it sunset" },
        { type: "input_image", image_url: "https://example.com/source.png" },
      ] }],
    });
  });

  it("accepts a standard multipart upload and converts it to a data URL", async () => {
    const responsesFetch = vi.fn(async () => imageResponse());
    const app = createImagesRoutes(responsesFetch);
    const form = new FormData();
    form.set("model", "gpt-image-2");
    form.set("prompt", "Make it sunset");
    form.set("image", new File(["hello"], "source.png", { type: "image/png" }));
    const res = await app.request("/v1/images/edits", { method: "POST", body: form });
    expect(res.status).toBe(200);
    expect(await (responsesFetch.mock.calls[0][0] as Request).json()).toMatchObject({
      input: [{ role: "user", content: [
        { type: "input_text", text: "Make it sunset" },
        { type: "input_image", image_url: "data:image/png;base64,aGVsbG8=" },
      ] }],
    });
  });

  it("rejects masks explicitly because the upstream tool rejects them", async () => {
    const app = createImagesRoutes(async () => imageResponse());
    const res = await app.request("/v1/images/edits", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-image-2", prompt: "Change this", images: [{ image_url: "data:image/png;base64,aA==" }],
        mask: { image_url: "data:image/png;base64,aA==" },
      }),
    });
    expect(res.status).toBe(400);
  });
});

describe("image model discovery", () => {
  it("does not appear alone before the upstream model catalog has loaded", async () => {
    const app = createModelRoutes();
    const models = await (await app.request("/v1/models")).json() as { data: Array<{ id: string }> };
    expect(models.data).toEqual([]);

    const catalog = await (await app.request("/v1/models/catalog")).json() as Array<{
      id: string;
      outputModalities?: string[];
    }>;
    expect(catalog.find((model) => model.id === "gpt-image-2")).toBeUndefined();
  });
});
