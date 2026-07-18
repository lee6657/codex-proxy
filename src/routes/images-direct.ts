import type { AccountPool } from "../auth/account-pool.js";
import { CodexApiError } from "../proxy/codex-api.js";
import type { CookieJar } from "../proxy/cookie-jar.js";
import type { ProxyPool } from "../proxy/proxy-pool.js";
import { buildCodexApi } from "./shared/proxy-handler-utils.js";
import { handleCodexApiError, toErrorStatus } from "./shared/proxy-error-handler.js";

export type ImageEndpoint = "generations" | "edits";
export type DirectImagesFetch = (
  endpoint: ImageEndpoint,
  body: Record<string, unknown>,
  signal?: AbortSignal,
) => Promise<Response>;

function openAIError(message: string, code: string) {
  return JSON.stringify({
    error: { message, type: "server_error", param: null, code },
  });
}

function responseFromCodexError(error: CodexApiError, status = error.status): Response {
  const headers = new Headers(error.headers);
  if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const body = error.body || openAIError(error.message, "codex_api_error");
  return new Response(body, { status: toErrorStatus(status), headers });
}

function responseWithRelease(
  response: Response,
  release: () => void,
): Response {
  if (!response.body) {
    release();
    return response;
  }

  const reader = response.body.getReader();
  let released = false;
  const finish = () => {
    if (released) return;
    released = true;
    release();
  };

  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (chunk.done) {
          finish();
          controller.close();
          return;
        }
        controller.enqueue(chunk.value);
      } catch (error) {
        finish();
        controller.error(error);
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        finish();
      }
    },
  });

  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

export function createCodexDirectImagesFetch(
  accountPool: AccountPool,
  cookieJar?: CookieJar,
  proxyPool?: ProxyPool,
): DirectImagesFetch {
  return async (endpoint, body, signal) => {
    const model = typeof body.model === "string" ? body.model : "gpt-image-2";
    const triedEntryIds: string[] = [];
    let lastError: CodexApiError | null = null;
    let modelRetried = false;

    while (accountPool.hasAvailableAccounts(triedEntryIds)) {
      const acquired = accountPool.acquire({ model, excludeIds: triedEntryIds });
      if (!acquired) break;
      triedEntryIds.push(acquired.entryId);

      // CLIProxyAPI excludes free-plan Codex credentials from image execution:
      // the upstream either strips the image tool or does not expose /images/*.
      if (accountPool.getEntry(acquired.entryId)?.planType?.toLowerCase() === "free") {
        accountPool.releaseWithoutCounting(acquired.entryId);
        continue;
      }

      const api = buildCodexApi(
        acquired.token,
        acquired.accountId,
        cookieJar,
        acquired.entryId,
        proxyPool,
      );

      try {
        const response = await api.createImageResponse(endpoint, body, signal);
        return responseWithRelease(response, () => accountPool.release(acquired.entryId, {
          image_request_attempted: true,
          image_request_succeeded: true,
        }));
      } catch (error) {
        if (!(error instanceof CodexApiError)) {
          accountPool.release(acquired.entryId, {
            image_request_attempted: true,
            image_request_succeeded: false,
          });
          const message = error instanceof Error ? error.message : String(error);
          return new Response(openAIError(message, "image_generation_failed"), {
            status: 502,
            headers: { "Content-Type": "application/json" },
          });
        }

        lastError = error;
        // A missing direct Images route is a capability signal, not a
        // Cloudflare path-block. Return it immediately so image-2 can use the
        // Responses-tool fallback without penalizing or disabling accounts.
        if (error.status === 404 || error.status === 405) {
          accountPool.releaseWithoutCounting(acquired.entryId);
          return responseFromCodexError(error);
        }
        const decision = handleCodexApiError(
          error,
          accountPool,
          acquired.entryId,
          model,
          "Images",
          modelRetried,
          cookieJar,
        );
        accountPool.release(acquired.entryId, {
          image_request_attempted: true,
          image_request_succeeded: false,
        });

        if (decision.action === "retry") {
          modelRetried ||= decision.markModelRetried === true;
          continue;
        }
        return responseFromCodexError(error, decision.status);
      }
    }

    if (lastError) return responseFromCodexError(lastError);
    return new Response(openAIError("No available accounts for image generation", "no_available_accounts"), {
      status: 503,
      headers: { "Content-Type": "application/json" },
    });
  };
}
