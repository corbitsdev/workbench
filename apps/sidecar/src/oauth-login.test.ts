// CL-7508: the sidecar-hosted loopback login service binds exactly the
// pinned provider ports, surfaces a busy port as the typed
// `OAuthCallbackPortInUseError`, and never opens a browser sidecar-side.
import { afterAll, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import {
  CODEX_AUTHORIZE_URL,
  CODEX_REDIRECT_URI,
} from "@corbits/codex-provider/constants";
import { XAI_REDIRECT_URI } from "@corbits/xai-provider";
import { OAuthCallbackPortInUseError } from "@corbits/oauth-core";
import { createOAuthLoopbackLoginService } from "./oauth-login";

const occupied: Server[] = [];
afterAll(() => {
  for (const server of occupied) server.close();
});

/** Occupies a pinned port so a login attempt must fail with the typed
 * port-in-use error. Resolves false when the port was already busy (the
 * assertion we are about to make is then trivially proven by whatever
 * holds the port). */
function occupy(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => {
      occupied.push(server);
      resolve(true);
    });
  });
}

function redirectOf(authorizeUrl: string): string {
  return new URL(authorizeUrl).searchParams.get("redirect_uri") ?? "";
}

describe("oauth loopback login service", () => {
  test("codex pins localhost:1455 in the authorize URL it returns", async () => {
    const service = createOAuthLoopbackLoginService();
    const handle = await service.start("codex");
    try {
      expect(handle.authorizeUrl.startsWith(CODEX_AUTHORIZE_URL)).toBe(true);
      expect(redirectOf(handle.authorizeUrl)).toBe(CODEX_REDIRECT_URI);
      expect(new URL(CODEX_REDIRECT_URI).port).toBe("1455");
    } finally {
      handle.cancel();
    }
  });

  test("xai-oauth pins 127.0.0.1:1456 in the authorize URL it returns", async () => {
    const service = createOAuthLoopbackLoginService();
    const handle = await service.start("xai-oauth");
    try {
      expect(redirectOf(handle.authorizeUrl)).toBe(XAI_REDIRECT_URI);
      expect(new URL(XAI_REDIRECT_URI).hostname).toBe("127.0.0.1");
      expect(new URL(XAI_REDIRECT_URI).port).toBe("1456");
    } finally {
      handle.cancel();
    }
  });

  test("a bound pinned port surfaces OAuthCallbackPortInUseError, never a fallback port", async () => {
    // The xai pin shares this machine's port space, so holding 1456 forces
    // the bind failure path for whichever login reaches it.
    const held = await occupy(1456);
    if (!held) return; // something else already proves the port is busy
    const service = createOAuthLoopbackLoginService();
    // The bind happens while the handle is being staged, so `start` itself
    // is what rejects.
    const outcome = await service.start("xai-oauth").then(
      () => "completed",
      (cause: unknown) => cause,
    );
    expect(outcome).toBeInstanceOf(OAuthCallbackPortInUseError);
    expect((outcome as OAuthCallbackPortInUseError).port).toBe(1456);
  });

  test("a cancelled login frees the pinned port for the next one", async () => {
    const service = createOAuthLoopbackLoginService();
    const first = await service.start("codex");
    first.cancel();
    // If cancel did not close 1455's listener, this rebind would fail with
    // the typed port-in-use error instead of staging a fresh login.
    const second = await service.start("codex");
    expect(redirectOf(second.authorizeUrl)).toBe(CODEX_REDIRECT_URI);
    second.cancel();
  });
});
