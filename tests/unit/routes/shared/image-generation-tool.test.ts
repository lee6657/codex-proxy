import { describe, expect, it } from "vitest";
import {
  hasImageGenerationTool,
  prepareImageGenerationRequest,
} from "@src/routes/shared/image-generation-tool.js";
import type { CodexResponsesRequest } from "@src/proxy/codex-types.js";
import { annotateImageGenOutcome } from "@src/routes/shared/proxy-handler-utils.js";

function request(tools?: unknown[], model = "gpt-5.4"): CodexResponsesRequest {
  return {
    model,
    input: [{ role: "user", content: "draw a lighthouse" }],
    stream: true,
    store: false,
    ...(tools !== undefined ? { tools } : {}),
  };
}

describe("prepareImageGenerationRequest", () => {
  it("appends the default image tool without mutating existing tools", () => {
    const original = request([{ type: "web_search" }]);
    const prepared = prepareImageGenerationRequest(original, {
      autoInject: true,
      planType: "plus",
    });

    expect(prepared.injected).toBe(true);
    expect(prepared.expectsImageGeneration).toBe(false);
    expect(prepared.request.tools).toEqual([
      { type: "web_search" },
      { type: "image_generation", output_format: "png" },
    ]);
    expect(original.tools).toEqual([{ type: "web_search" }]);
  });

  it.each([
    { tools: [{ type: "image_generation", output_format: "webp" }] },
    { tools: [{ type: "function", name: "image_gen.imagegen" }] },
    { tools: [{ type: "namespace", name: "image_gen", tools: [{ type: "function", name: "imagegen" }] }] },
  ])("recognizes an existing image tool and does not duplicate it", ({ tools }) => {
    const original = request(tools);
    const prepared = prepareImageGenerationRequest(original, {
      autoInject: true,
      planType: "plus",
    });

    expect(hasImageGenerationTool(tools)).toBe(true);
    expect(prepared.request).toBe(original);
    expect(prepared.injected).toBe(false);
    expect(prepared.expectsImageGeneration).toBe(true);
  });

  it.each([
    { name: "disabled", options: { autoInject: false, planType: "plus" } },
    { name: "free plan", options: { autoInject: true, planType: "free" } },
    { name: "Responses Lite", options: { autoInject: true, planType: "plus", responsesLite: true } },
  ])("does not inject when $name", ({ options }) => {
    const original = request();
    const prepared = prepareImageGenerationRequest(original, options);
    expect(prepared.request).toBe(original);
    expect(prepared.expectsImageGeneration).toBe(false);
  });

  it("does not inject into spark models", () => {
    const original = request(undefined, "gpt-5.3-codex-spark");
    const prepared = prepareImageGenerationRequest(original, {
      autoInject: true,
      planType: "plus",
    });
    expect(prepared.request).toBe(original);
    expect(prepared.expectsImageGeneration).toBe(false);
  });
});

describe("automatic image usage accounting", () => {
  it("does not count an unused auto-injected tool as a failed image request", () => {
    const usage = { input_tokens: 10, output_tokens: 5 };
    expect(annotateImageGenOutcome(usage, false)).toBe(usage);
  });

  it("counts image output as a successful request without explicit client tools", () => {
    expect(annotateImageGenOutcome({
      input_tokens: 10,
      output_tokens: 5,
      image_input_tokens: 1,
      image_output_tokens: 2,
    }, false)).toMatchObject({
      image_request_attempted: true,
      image_request_succeeded: true,
    });
  });
});
