/** Image-only models exposed by the OpenAI Images compatibility routes. */

import { getModelInfo } from "./model-store.js";

export const DEFAULT_IMAGE_MODEL_ID = "gpt-image-2";
export const BUILTIN_IMAGE_MODEL_IDS = ["gpt-image-1.5", DEFAULT_IMAGE_MODEL_ID] as const;

const BUILTIN_IMAGE_MODELS = new Set<string>(BUILTIN_IMAGE_MODEL_IDS);

/**
 * Recognize built-in image models and future image-only entries returned by
 * the Codex model catalog. The dynamic branch prevents every new image model
 * from requiring another route-specific hard-coded allowlist.
 */
export function isImageOnlyModel(modelId: string): boolean {
  const normalized = modelId.trim().toLowerCase();
  if (BUILTIN_IMAGE_MODELS.has(normalized)) return true;

  const info = getModelInfo(normalized);
  return info?.outputModalities?.includes("image") === true
    && info.outputModalities.includes("text") === false;
}
