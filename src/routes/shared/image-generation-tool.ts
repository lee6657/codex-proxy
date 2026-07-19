import type { CodexResponsesRequest } from "../../proxy/codex-types.js";
import { isRecord } from "../../translation/shared-utils.js";

const AUTO_IMAGE_GENERATION_TOOL = {
  type: "image_generation",
  output_format: "png",
} as const;

function isImageGenerationFunctionTool(tool: Record<string, unknown>): boolean {
  if (tool.type === "function" && tool.name === "image_gen.imagegen") return true;
  if (tool.type !== "namespace" || tool.name !== "image_gen" || !Array.isArray(tool.tools)) {
    return false;
  }
  return tool.tools.some((nested) =>
    isRecord(nested) && nested.type === "function" && nested.name === "imagegen"
  );
}

export function hasImageGenerationTool(tools: unknown[] | undefined): boolean {
  return Array.isArray(tools) && tools.some((tool) =>
    isRecord(tool) && (tool.type === "image_generation" || isImageGenerationFunctionTool(tool))
  );
}

export interface PrepareImageGenerationRequestOptions {
  autoInject: boolean;
  planType?: string | null;
  responsesLite?: boolean;
}

export interface PreparedImageGenerationRequest {
  request: CodexResponsesRequest;
  /** Explicit client intent used for failure accounting. Auto availability alone is not an attempt. */
  expectsImageGeneration: boolean;
  injected: boolean;
}

/** Build the account-specific upstream request without mutating the client payload. */
export function prepareImageGenerationRequest(
  request: CodexResponsesRequest,
  options: PrepareImageGenerationRequestOptions,
): PreparedImageGenerationRequest {
  if (hasImageGenerationTool(request.tools)) {
    return { request, expectsImageGeneration: true, injected: false };
  }

  const isFree = options.planType?.trim().toLowerCase() === "free";
  const isSpark = request.model.toLowerCase().endsWith("spark");
  if (!options.autoInject || options.responsesLite || isFree || isSpark) {
    return { request, expectsImageGeneration: false, injected: false };
  }

  return {
    request: {
      ...request,
      tools: [...(request.tools ?? []), { ...AUTO_IMAGE_GENERATION_TOOL }],
    },
    expectsImageGeneration: false,
    injected: true,
  };
}
