/** Image-only models exposed by the OpenAI Images compatibility routes. */

export const DEFAULT_IMAGE_MODEL_ID = "gpt-image-2";

const IMAGE_ONLY_MODELS = new Set<string>([
  DEFAULT_IMAGE_MODEL_ID,
]);

export function isImageOnlyModel(modelId: string): boolean {
  return IMAGE_ONLY_MODELS.has(modelId.trim().toLowerCase());
}

