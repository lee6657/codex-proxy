import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountPool } from "@src/auth/account-pool.js";
import { CodexApiError } from "@src/proxy/codex-api.js";

const mocks = vi.hoisted(() => ({
  createImageResponse: vi.fn(),
  handleCodexApiError: vi.fn(),
}));

vi.mock("@src/routes/shared/proxy-handler-utils.js", () => ({
  buildCodexApi: () => ({ createImageResponse: mocks.createImageResponse }),
}));

vi.mock("@src/routes/shared/proxy-error-handler.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("@src/routes/shared/proxy-error-handler.js")>();
  return { ...original, handleCodexApiError: mocks.handleCodexApiError };
});

import { createCodexDirectImagesFetch } from "@src/routes/images-direct.js";

function createPool(): AccountPool {
  return {
    hasAvailableAccounts: vi.fn(() => true),
    acquire: vi.fn(() => ({
      entryId: "account-1",
      token: "token-1",
      accountId: "chatgpt-account-1",
      prevSlotMs: null,
    })),
    getEntry: vi.fn(() => ({ planType: "plus" })),
    release: vi.fn(),
    releaseWithoutCounting: vi.fn(),
  } as unknown as AccountPool;
}

describe("Codex direct Images account handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not ban or penalize an account whose group lacks native Images permission", async () => {
    const pool = createPool();
    mocks.createImageResponse.mockRejectedValue(new CodexApiError(403, JSON.stringify({
      error: {
        message: "Image generation is not enabled for this group",
        type: "permission_error",
      },
    })));

    const response = await createCodexDirectImagesFetch(pool)("generations", {
      model: "gpt-image-2",
      prompt: "Draw a cat",
    });

    expect(response.status).toBe(403);
    expect(pool.releaseWithoutCounting).toHaveBeenCalledWith("account-1");
    expect(pool.release).not.toHaveBeenCalled();
    expect(mocks.handleCodexApiError).not.toHaveBeenCalled();
  });
});
