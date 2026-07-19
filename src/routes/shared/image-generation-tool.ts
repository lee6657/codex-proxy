import type { CodexResponsesRequest } from "../../proxy/codex-types.js";
import { isRecord } from "../../translation/shared-utils.js";

const AUTO_IMAGE_GENERATION_TOOL = {
  type: "image_generation",
  output_format: "png",
} as const;

const IMAGE_CREATION_INTENT = [
  /\b(?:draw|paint|sketch|illustrate)\b/i,
  /\b(?:generate|create|draw|paint|render|design|make|edit|modify|transform|retouch|inpaint|outpaint)\b.{0,48}\b(?:image|picture|photo|illustration|poster|logo|wallpaper|portrait)\b/i,
  /\b(?:image|picture|photo|illustration|poster|logo|wallpaper|portrait)\b.{0,48}\b(?:generate|create|draw|paint|render|design|make|edit|modify|transform|retouch|inpaint|outpaint)\b/i,
  /(?:生成|创建|制作|绘制|设计|编辑|修改|更改|重绘|修复|润色|扩图|改图|修图|换背景|去背景).{0,24}(?:图片|图像|图画|插图|海报|照片|相片|头像|壁纸|标志|logo)/i,
  /(?:图片|图像|图画|插图|海报|照片|相片|头像|壁纸).{0,24}(?:生成|创建|制作|绘制|设计|编辑|修改|更改|改成|换成|变成|重绘|修复|润色|扩展|去除|移除|添加)/i,
  /(?:^|[，。！？,.!?\s])(?:请|帮我|给我)?(?:画|绘制|生图)(?:一|个|张|幅|下|出|：|:|\s)/i,
];

const REFERENCED_IMAGE_EDIT_INTENT = /\b(?:edit|change|modify|replace|remove|add|transform|retouch|inpaint|outpaint)\b|(?:修改|编辑|更改|改成|换成|换掉|去掉|删除|添加|变成|调整|重绘|修图|扩图|换背景|去背景)/i;

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

function latestUserInput(request: CodexResponsesRequest): { text: string; hasImage: boolean } {
  for (let index = request.input.length - 1; index >= 0; index--) {
    const item = request.input[index];
    if (!("role" in item) || item.role !== "user") continue;
    if (typeof item.content === "string") {
      return { text: item.content, hasImage: false };
    }
    return {
      text: item.content
        .filter((part) => part.type === "input_text")
        .map((part) => part.text)
        .join("\n"),
      hasImage: item.content.some((part) => part.type === "input_image"),
    };
  }
  return { text: "", hasImage: false };
}

/** Keep ordinary chat requests tool-free while still enabling natural-language image tasks. */
export function hasImageGenerationIntent(request: CodexResponsesRequest): boolean {
  const { text, hasImage } = latestUserInput(request);
  if (IMAGE_CREATION_INTENT.some((pattern) => pattern.test(text))) return true;
  return hasImage && REFERENCED_IMAGE_EDIT_INTENT.test(text);
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
  if (
    !options.autoInject ||
    options.responsesLite ||
    isFree ||
    isSpark ||
    !hasImageGenerationIntent(request)
  ) {
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
