/** OpenAI Images API compatibility layer backed by Codex Responses tools. */

import { Hono } from "hono";
import { isRecord } from "../translation/shared-utils.js";
import { DEFAULT_IMAGE_MODEL_ID, isImageOnlyModel } from "../models/image-models.js";

const IMAGE_HOST_MODEL = "gpt-5.4-mini";
const IMAGE_TOOL_FIELDS = [
  "size", "quality", "background", "output_format", "output_compression", "moderation", "partial_images",
] as const;

type ResponsesFetch = (request: Request) => Promise<Response>;
type ResponseFormat = "b64_json" | "url";

interface ImageRequest {
  model?: string;
  prompt?: string;
  n?: number;
  response_format?: string;
  stream?: boolean;
  images?: Array<{ image_url?: string }>;
  mask?: { image_url?: string };
  [key: string]: unknown;
}

function openAIError(message: string, param: string | null, code: string) {
  return { error: { message, type: "invalid_request_error", param, code } };
}

function imageMimeType(format: string): string {
  if (format === "jpeg" || format === "jpg") return "image/jpeg";
  if (format === "webp") return "image/webp";
  return "image/png";
}

function imageData(result: string, outputFormat: string, responseFormat: ResponseFormat): Record<string, unknown> {
  return responseFormat === "url"
    ? { url: `data:${imageMimeType(outputFormat)};base64,${result}` }
    : { b64_json: result };
}

function extractImagesResponse(payload: unknown, responseFormat: ResponseFormat): Record<string, unknown> | null {
  if (!isRecord(payload) || !Array.isArray(payload.output)) return null;
  const data: Record<string, unknown>[] = [];
  let firstItem: Record<string, unknown> | null = null;
  for (const item of payload.output) {
    if (!isRecord(item) || item.type !== "image_generation_call" || typeof item.result !== "string" || !item.result) continue;
    firstItem ??= item;
    const image = imageData(item.result, typeof item.output_format === "string" ? item.output_format : "png", responseFormat);
    if (typeof item.revised_prompt === "string" && item.revised_prompt) image.revised_prompt = item.revised_prompt;
    data.push(image);
  }
  if (data.length === 0) return null;
  const result: Record<string, unknown> = {
    created: typeof payload.created_at === "number" ? Math.floor(payload.created_at) : Math.floor(Date.now() / 1000),
    data,
  };
  if (firstItem) for (const key of ["background", "output_format", "quality", "size"] as const) {
    if (typeof firstItem[key] === "string") result[key] = firstItem[key];
  }
  if (isRecord(payload.tool_usage) && isRecord(payload.tool_usage.image_gen)) result.usage = payload.tool_usage.image_gen;
  return result;
}

function parseResponseFormat(value: unknown): ResponseFormat | null {
  const format = value ?? "b64_json";
  return format === "b64_json" || format === "url" ? format : null;
}

function makeHeaders(request: Request): Headers {
  const headers = new Headers({ "Content-Type": "application/json" });
  for (const key of ["Authorization", "x-api-key"]) {
    const value = request.headers.get(key);
    if (value) headers.set(key, value);
  }
  return headers;
}

function buildTool(body: ImageRequest): Record<string, unknown> {
  const tool: Record<string, unknown> = { type: "image_generation" };
  for (const key of IMAGE_TOOL_FIELDS) if (body[key] !== undefined) tool[key] = body[key];
  return tool;
}

function buildResponsesBody(prompt: string, body: ImageRequest, images: string[], stream: boolean): Record<string, unknown> {
  const content: Record<string, unknown>[] = [{ type: "input_text", text: prompt }];
  for (const image_url of images) content.push({ type: "input_image", image_url });
  return {
    model: IMAGE_HOST_MODEL,
    stream,
    input: [{ role: "user", content: images.length > 0 ? content : prompt }],
    tools: [buildTool(body)],
  };
}

function parseSseFrame(frame: string): unknown[] {
  const payloads: unknown[] = [];
  for (const line of frame.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    try { payloads.push(JSON.parse(line.slice(5).trim())); } catch { /* ignore keepalives */ }
  }
  return payloads;
}

function toImageStream(upstream: Response, responseFormat: ResponseFormat, prefix: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    async start(controller) {
      if (!upstream.body) return controller.close();
      const reader = upstream.body.getReader();
      const decoder = new TextDecoder();
      let pending = "";
      const emit = (event: string, data: Record<string, unknown>) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`));
      };
      const process = (frame: string) => {
        for (const event of parseSseFrame(frame)) {
          if (!isRecord(event)) continue;
          if (event.type === "response.image_generation_call.partial_image" && typeof event.partial_image_b64 === "string") {
            emit(`${prefix}.partial_image`, {
              partial_image_index: typeof event.partial_image_index === "number" ? event.partial_image_index : 0,
              ...imageData(event.partial_image_b64, typeof event.output_format === "string" ? event.output_format : "png", responseFormat),
            });
          }
          if (event.type === "response.output_item.done" && isRecord(event.item) && event.item.type === "image_generation_call" && typeof event.item.result === "string") {
            const data = imageData(event.item.result, typeof event.item.output_format === "string" ? event.item.output_format : "png", responseFormat);
            if (typeof event.item.revised_prompt === "string") data.revised_prompt = event.item.revised_prompt;
            emit(`${prefix}.completed`, data);
          }
          if (event.type === "response.failed" || event.type === "error") {
            emit(`${prefix}.error`, { error: event.error ?? event });
          }
        }
      };
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          pending += decoder.decode(value, { stream: true });
          const frames = pending.split(/\r?\n\r?\n/);
          pending = frames.pop() ?? "";
          for (const frame of frames) process(frame);
        }
        if (pending.trim()) process(pending);
      } catch (error) {
        emit(`${prefix}.error`, { error: { message: error instanceof Error ? error.message : String(error) } });
      }
      controller.close();
    },
  });
}

async function fileToDataUrl(file: File): Promise<string> {
  const bytes = Buffer.from(await file.arrayBuffer()).toString("base64");
  return `data:${file.type || "application/octet-stream"};base64,${bytes}`;
}

async function requestImages(
  c: { req: { raw: Request }; json: (data: Record<string, unknown>, status?: number) => Response },
  responsesFetch: ResponsesFetch,
  body: ImageRequest,
  images: string[],
  prefix: string,
): Promise<Response> {
  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  if (!prompt) return c.json(openAIError("Invalid request: prompt is required", "prompt", "missing_required_parameter"), 400);
  if (body.model !== undefined && !isImageOnlyModel(body.model)) {
    return c.json(openAIError(`Model '${body.model}' is not supported by this endpoint; use '${DEFAULT_IMAGE_MODEL_ID}'`, "model", "model_not_found"), 400);
  }
  if (body.n !== undefined && body.n !== 1) return c.json(openAIError("Only n=1 is supported", "n", "unsupported_parameter"), 400);
  const responseFormat = parseResponseFormat(body.response_format);
  if (!responseFormat) return c.json(openAIError("response_format must be 'b64_json' or 'url'", "response_format", "invalid_value"), 400);

  const wantsStream = body.stream === true;
  const upstream = await responsesFetch(new Request("http://internal/v1/responses", {
    method: "POST",
    headers: makeHeaders(c.req.raw),
    body: JSON.stringify(buildResponsesBody(prompt, body, images, wantsStream)),
  }));
  if (!upstream.ok) return new Response(upstream.body, { status: upstream.status, headers: upstream.headers });
  if (wantsStream) {
    return new Response(toImageStream(upstream, responseFormat, prefix), {
      headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache", Connection: "keep-alive" },
    });
  }
  const imagesResponse = extractImagesResponse(await upstream.json(), responseFormat);
  if (!imagesResponse) return c.json(openAIError(
    "Upstream completed without an image. Ensure the account is ChatGPT Plus or higher.", null, "image_generation_failed",
  ), 502);
  return c.json(imagesResponse);
}

export function createImagesRoutes(responsesFetch: ResponsesFetch): Hono {
  const app = new Hono();

  app.post("/v1/images/generations", async (c) => {
    let body: ImageRequest;
    try { body = await c.req.json<ImageRequest>(); } catch {
      return c.json(openAIError("Invalid request: body must be valid JSON", null, "invalid_json"), 400);
    }
    return requestImages(c, responsesFetch, body, [], "image_generation");
  });

  app.post("/v1/images/edits", async (c) => {
    const contentType = c.req.header("Content-Type")?.toLowerCase() ?? "";
    if (contentType.startsWith("application/json")) {
      let body: ImageRequest;
      try { body = await c.req.json<ImageRequest>(); } catch {
        return c.json(openAIError("Invalid request: body must be valid JSON", null, "invalid_json"), 400);
      }
      const images = Array.isArray(body.images)
        ? body.images.flatMap((item) => typeof item?.image_url === "string" ? [item.image_url] : [])
        : [];
      if (images.length === 0) return c.json(openAIError("images[].image_url is required", "images", "missing_required_parameter"), 400);
      if (body.mask?.image_url) return c.json(openAIError("mask is not supported by the Codex image_generation backend", "mask", "unsupported_parameter"), 400);
      return requestImages(c, responsesFetch, body, images, "image_edit");
    }
    if (!contentType.startsWith("multipart/form-data")) {
      return c.json(openAIError("Content-Type must be multipart/form-data or application/json", null, "invalid_request_error"), 400);
    }
    let form: FormData;
    try { form = await c.req.raw.formData(); } catch {
      return c.json(openAIError("Invalid multipart form data", null, "invalid_request_error"), 400);
    }
    const files = [...form.getAll("image[]"), ...form.getAll("image")].filter((value): value is File => typeof value !== "string");
    if (files.length === 0) return c.json(openAIError("image is required", "image", "missing_required_parameter"), 400);
    if (form.get("mask") !== null) return c.json(openAIError("mask is not supported by the Codex image_generation backend", "mask", "unsupported_parameter"), 400);
    const body: ImageRequest = {};
    for (const [key, value] of form.entries()) if (typeof value === "string") {
      if (key === "stream") body.stream = value === "true" || value === "1";
      else if (key === "n" || key === "output_compression" || key === "partial_images") body[key] = Number(value);
      else body[key] = value;
    }
    return requestImages(c, responsesFetch, body, await Promise.all(files.map(fileToDataUrl)), "image_edit");
  });

  return app;
}
