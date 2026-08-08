// The failure path for first-login provisioning: a broken hub call
// must not collapse to "nothing to do". `triggerFirstLoginProvisioning`
// should report it as a distinct error outcome, and the app shell must
// render a full blocking screen for it rather than silently continuing
// into a shell with zero benches.

import { afterEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { App } from "../src/app";
import { triggerFirstLoginProvisioning } from "../src/onboarding";
import type { SessionState } from "../src/session";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const noop = () => undefined;

const signedIn: SessionState = {
  kind: "signed-in",
  user: { id: "user_1", name: "Ada", email: "ada@example.com" },
};

describe("triggerFirstLoginProvisioning", () => {
  test("a structured error envelope becomes an error outcome, not null", async () => {
    globalThis.fetch = (async () =>
      json(
        {
          error: {
            code: "provisioning_failed",
            message: "Could not provision a workbench for this account.",
          },
        },
        500,
      )) as unknown as typeof fetch;

    const result = await triggerFirstLoginProvisioning();
    expect(result).toEqual({
      kind: "error",
      message: "Could not provision a workbench for this account.",
    });
  });

  test("a network failure becomes an error outcome", async () => {
    globalThis.fetch = (async () => {
      throw new Error("connection refused");
    }) as unknown as typeof fetch;

    const result = await triggerFirstLoginProvisioning();
    expect(result.kind).toBe("error");
    if (result.kind !== "error") throw new Error("unreachable");
    expect(result.message).toContain("connection refused");
  });

  test("an ordinary success still parses through", async () => {
    globalThis.fetch = (async () =>
      json({ kind: "existing-member" })) as unknown as typeof fetch;

    const result = await triggerFirstLoginProvisioning();
    expect(result).toEqual({ kind: "existing-member" });
  });
});

describe("App with a provisioning error", () => {
  test("blocks the shell with a retry action instead of rendering it", () => {
    const markup = renderToStaticMarkup(
      <App
        path="/"
        navigate={noop}
        session={signedIn}
        onSignedIn={noop}
        onSignOut={noop}
        onRetry={noop}
        provisioningError="Could not provision a workbench for this account."
        onRetryProvisioning={noop}
      />,
    );

    expect(markup).toContain("set up your workbench");
    expect(markup).toContain(
      "Could not provision a workbench for this account.",
    );
    expect(markup).not.toContain("shell-frame");
  });
});
