// The failure path for first-login provisioning: a broken hub call
// must not collapse to "nothing to do". `triggerFirstLoginProvisioning`
// should report it as a distinct error outcome, and the app shell must
// render a full blocking screen for it rather than silently continuing
// into a shell with zero benches.

import { ThemeProvider } from "@corbits/react-ui";
import { afterEach, describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { supportedCredentialProviders } from "@workbench/hub-client/credential-test";

import { App } from "../src/app";
import { NavigationProvider } from "../src/navigation";
import {
  CREDENTIAL_PROVIDERS,
  PRIMARY_CREDENTIAL_PROVIDERS,
  readHuggingFaceConnectReturn,
  readOpenRouterConnectReturn,
  SECONDARY_CREDENTIAL_PROVIDERS,
  submitCredential,
  testCredential,
  triggerFirstLoginProvisioning,
} from "../src/onboarding";
import { OnboardingPage } from "../src/pages/onboarding-page";
import { ONBOARDING_PATH } from "../src/routes";
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

describe("CREDENTIAL_PROVIDERS", () => {
  // ProviderPicker (onboarding-page.tsx) renders one card per entry here —
  // this is the data the cards are built from, so covering it covers what
  // actually shows up: one card per `@workbench/hub-client` provider the
  // hub can actually test a credential against, each with a distinct
  // honest one-liner and a real key-console link. Compared against
  // `supportedCredentialProviders()` directly, not a second hand-copied
  // list, so a provider added or removed there is caught here rather than
  // drifting silently.
  test("has one card for every provider the hub can test a credential against", () => {
    expect(CREDENTIAL_PROVIDERS.map((p) => p.id).sort()).toEqual(
      supportedCredentialProviders()
        .map((p) => p.id)
        .sort(),
    );
  });

  test("every card has a non-empty label, description, and key console link", () => {
    for (const provider of CREDENTIAL_PROVIDERS) {
      expect(provider.label.length).toBeGreaterThan(0);
      expect(provider.description.length).toBeGreaterThan(0);
      expect(provider.keyConsoleUrl).toMatch(/^https:\/\//);
    }
  });

  test("no two cards share the same description", () => {
    const descriptions = CREDENTIAL_PROVIDERS.map((p) => p.description);
    expect(new Set(descriptions).size).toBe(descriptions.length);
  });
});

describe("PRIMARY_CREDENTIAL_PROVIDERS and SECONDARY_CREDENTIAL_PROVIDERS", () => {
  test("the primary six lead in the owner's exact order", () => {
    expect(PRIMARY_CREDENTIAL_PROVIDERS.map((p) => p.id)).toEqual([
      "openai",
      "anthropic",
      "google-genai",
      "xai",
      "openrouter",
      "opencode-zen",
    ]);
  });

  test("groq, deepseek, and mistral sit behind the secondary group", () => {
    expect(SECONDARY_CREDENTIAL_PROVIDERS.map((p) => p.id)).toEqual([
      "groq",
      "deepseek",
      "mistral",
      "huggingface",
    ]);
  });

  test("primary and secondary together account for every card, primary first", () => {
    expect(CREDENTIAL_PROVIDERS).toEqual([
      ...PRIMARY_CREDENTIAL_PROVIDERS,
      ...SECONDARY_CREDENTIAL_PROVIDERS,
    ]);
  });
});

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

    const result = await triggerFirstLoginProvisioning("Ada's bench");
    expect(result).toEqual({
      kind: "error",
      message: "Could not provision a workbench for this account.",
    });
  });

  test("a network failure becomes an error outcome", async () => {
    globalThis.fetch = (async () => {
      throw new Error("connection refused");
    }) as unknown as typeof fetch;

    const result = await triggerFirstLoginProvisioning("Ada's bench");
    expect(result.kind).toBe("error");
    if (result.kind !== "error") throw new Error("unreachable");
    expect(result.message).toContain("connection refused");
  });

  test("an ordinary success still parses through", async () => {
    globalThis.fetch = (async () =>
      json({ kind: "existing-member" })) as unknown as typeof fetch;

    const result = await triggerFirstLoginProvisioning("Ada's bench");
    expect(result).toEqual({ kind: "existing-member" });
  });

  test("sends the workbench name in the provision request body", async () => {
    let requestBody: unknown = undefined;
    let requestInit: RequestInit | undefined;
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      requestInit = init;
      requestBody =
        init.body === undefined ? undefined : JSON.parse(init.body as string);
      return json({ kind: "existing-member" });
    }) as unknown as typeof fetch;

    await triggerFirstLoginProvisioning("Research bench");
    expect(requestBody).toEqual({ name: "Research bench" });
    expect(requestInit?.method).toBe("POST");
  });

  test("omits a body when no name is given (the shell routing probe)", async () => {
    let sentBody: unknown = "__sentinel__";
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      sentBody = init.body;
      return json({ kind: "existing-member" });
    }) as unknown as typeof fetch;

    await triggerFirstLoginProvisioning();
    expect(sentBody).toBeUndefined();
  });

  test("a provisioned bench with a server seed stays a 'provisioned' outcome — seeded is reported faithfully", async () => {
    // Regression guard: a server-side seed (operator-configured or
    // env-key-auto-planted key) must not collapse the outcome into
    // `existing-member` or otherwise hide that the bench was just
    // provisioned. The wizard reads `seeded` off this exact shape to
    // decide whether to skip the credential step (see
    // apps/web/test/onboarding.test.tsx's "App landing fresh on a
    // hub-seeded workbench" suite).
    let requestBody: unknown = undefined;
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      requestBody =
        init.body === undefined ? undefined : JSON.parse(init.body as string);
      return json({
        kind: "provisioned",
        tenantId: "ten_1",
        tenantSlug: "ada-user1",
        seeded: true,
        seedSkipReason: "operator_seed_key",
      });
    }) as unknown as typeof fetch;

    const result = await triggerFirstLoginProvisioning("Ada's bench");
    expect(requestBody).toEqual({ name: "Ada's bench" });
    expect(result).toEqual({
      kind: "provisioned",
      tenantId: "ten_1",
      tenantSlug: "ada-user1",
      seeded: true,
      seedSkipReason: "operator_seed_key",
    });
    // The credential step stays in the flow precisely because seeded is
    // reported faithfully, not folded away.
    if (result.kind === "provisioned") expect(result.seeded).toBe(true);
  });

  test("an existing member whose bench is not fully seeded reports seeded: false, not silently dropped", async () => {
    // Regression guard for the bench_unseeded defect: a returning user
    // with a real membership but no working credential yet must not read
    // as an ordinary, fully-set-up existing member. Before this fix the
    // client discarded `seeded` entirely for `existing-member`.
    globalThis.fetch = (async () =>
      json({
        kind: "existing-member",
        seeded: false,
      })) as unknown as typeof fetch;

    const result = await triggerFirstLoginProvisioning();
    expect(result).toEqual({ kind: "existing-member", seeded: false });
  });

  test("an existing member on someone else's tenant carries no seeded field", async () => {
    globalThis.fetch = (async () =>
      json({ kind: "existing-member" })) as unknown as typeof fetch;

    const result = await triggerFirstLoginProvisioning();
    expect(result).toEqual({ kind: "existing-member" });
  });
});

describe("testCredential", () => {
  test("a rejected key is reported with the hub's own reason", async () => {
    let requestBody: unknown = null;
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      requestBody = JSON.parse((init as RequestInit).body as string);
      return json(
        { error: { code: "invalid_credential", message: "invalid api key" } },
        422,
      );
    }) as unknown as typeof fetch;

    const result = await testCredential("openai", "sk-bad");
    expect(result).toEqual({ ok: false, message: "invalid api key" });
    expect(requestBody).toEqual({ provider: "openai", apiKey: "sk-bad" });
  });

  test("an accepted key reports ok", async () => {
    globalThis.fetch = (async () =>
      json({ ok: true })) as unknown as typeof fetch;

    const result = await testCredential("anthropic", "sk-ant-good");
    expect(result).toEqual({ ok: true });
  });
});

describe("submitCredential", () => {
  test("a rejected key comes back as a rejected outcome with the hub's own reason", async () => {
    globalThis.fetch = (async () =>
      json(
        { error: { code: "invalid_credential", message: "invalid x-api-key" } },
        422,
      )) as unknown as typeof fetch;

    const result = await submitCredential("anthropic", "sk-ant-bad");
    expect(result).toEqual({ kind: "rejected", message: "invalid x-api-key" });
  });

  test("a seeded bench reports which routines were confirmed", async () => {
    let requestBody: unknown = null;
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      requestBody = JSON.parse((init as RequestInit).body as string);
      return json({
        kind: "seeded",
        tenantId: "ten_1",
        tenantSlug: "ada-user1",
        workflows: ["echo", "assistant"],
      });
    }) as unknown as typeof fetch;

    const result = await submitCredential("google-genai", "AIza-good");
    expect(result).toEqual({
      kind: "seeded",
      tenantId: "ten_1",
      tenantSlug: "ada-user1",
      workflows: ["echo", "assistant"],
    });
    expect(requestBody).toEqual({
      provider: "google-genai",
      apiKey: "AIza-good",
    });
  });

  test("a network failure is reported, never mistaken for a bad key", async () => {
    globalThis.fetch = (async () => {
      throw new Error("connection refused");
    }) as unknown as typeof fetch;

    const result = await submitCredential("anthropic", "sk-ant-good");
    expect(result.kind).toBe("error");
    if (result.kind !== "error") throw new Error("unreachable");
    expect(result.message).toContain("connection refused");
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

describe("App at the onboarding path", () => {
  const renderOnboarding = () =>
    renderToStaticMarkup(
      <App
        path={ONBOARDING_PATH}
        navigate={noop}
        session={signedIn}
        onSignedIn={noop}
        onSignOut={noop}
        onRetry={noop}
      />,
    );

  test("never renders the shell — no rail, no bench dock, nothing", () => {
    const markup = renderOnboarding();
    expect(markup).not.toContain("shell-frame");
    expect(markup).not.toContain("shell-bench-dock");
  });

  test("shows the restrained step label and progress rail instead of a stepper", () => {
    const markup = renderOnboarding();
    // No naming step (CL-6089): provisioning starts immediately, under a
    // default name derived from the account, before the credential step.
    expect(markup).toContain("Step 1 of 3");
    expect(markup).toContain("Setting up your workbench");
    expect(markup).toContain("dialog-stepper-track");
  });
});

describe("App landing fresh on a hub-seeded workbench", () => {
  test("a freshly provisioned, fully seeded bench skips the credential step entirely (CL-6101)", async () => {
    // A hub-owned key (the env-key auto-plant, or the older
    // ANTHROPIC_API_KEY path) already deployed and confirmed the
    // default workflow set by the time `/api/onboarding/provision`
    // answers — there is nothing left to prove or connect, so the
    // wizard must land straight on the finished ending, exactly like a
    // returning fully-seeded member does.
    globalThis.fetch = (async (url: string) => {
      if (url === "/api/onboarding/provision") {
        return json({
          kind: "provisioned",
          tenantId: "ten_1",
          tenantSlug: "ada-user1",
          seeded: true,
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as unknown as typeof fetch;

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      act(() => {
        root.render(
          <App
            path={ONBOARDING_PATH}
            navigate={noop}
            session={signedIn}
            onSignedIn={noop}
            onSignOut={noop}
            onRetry={noop}
          />,
        );
      });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });

      expect(container.textContent).toContain("Your workbench is ready");
      expect(container.textContent).toContain("Meet Myra");
      expect(container.textContent).not.toContain("Add an inference credential");
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });

  test("a freshly provisioned bench with no working credential still shows the credential step", async () => {
    globalThis.fetch = (async (url: string) => {
      if (url === "/api/onboarding/provision") {
        return json({
          kind: "provisioned",
          tenantId: "ten_1",
          tenantSlug: "ada-user1",
          seeded: false,
          seedSkipReason: "no operator key configured",
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as unknown as typeof fetch;

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      act(() => {
        root.render(
          <App
            path={ONBOARDING_PATH}
            navigate={noop}
            session={signedIn}
            onSignedIn={noop}
            onSignOut={noop}
            onRetry={noop}
          />,
        );
      });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });

      expect(container.textContent).toContain("Add an inference credential");
      expect(container.textContent).not.toContain("Your workbench is ready");
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });
});

describe("App once onboarding is behind you", () => {
  test("mounts the shell for an ordinary route", () => {
    globalThis.fetch = (async () =>
      json({ data: [] })) as unknown as typeof fetch;

    const markup = renderToStaticMarkup(
      <ThemeProvider>
        <App
          path="/"
          navigate={noop}
          session={signedIn}
          onSignedIn={noop}
          onSignOut={noop}
          onRetry={noop}
        />
      </ThemeProvider>,
    );

    expect(markup).toContain("shell-frame");
  });
});

describe("readOpenRouterConnectReturn", () => {
  test("an unrelated query string is nobody's outcome", () => {
    expect(readOpenRouterConnectReturn("")).toBeNull();
    expect(readOpenRouterConnectReturn("?foo=bar")).toBeNull();
  });

  test("a connected return carries the bench, with no routine list yet — that comes from completeSetup", () => {
    expect(
      readOpenRouterConnectReturn(
        "?connect=openrouter&outcome=connected&tenantSlug=ada-user1",
      ),
    ).toEqual({
      kind: "connected",
      tenantSlug: "ada-user1",
    });
  });

  test("a connected return missing its details is an error, never a fabricated success", () => {
    const result = readOpenRouterConnectReturn(
      "?connect=openrouter&outcome=connected",
    );
    expect(result?.kind).toBe("error");
  });

  test("a known failure code maps to its own copy", () => {
    const result = readOpenRouterConnectReturn(
      "?connect=openrouter&outcome=error&code=exchange_failed",
    );
    expect(result?.kind).toBe("error");
    if (result?.kind === "error")
      expect(result.message).toContain("did not hand back a key");
  });

  test("a rate-limited start explains OpenRouter limits key creation, not internal vocabulary", () => {
    const result = readOpenRouterConnectReturn(
      "?connect=openrouter&outcome=error&code=rate_limited",
    );
    expect(result?.kind).toBe("error");
    if (result?.kind === "error") {
      expect(result.message).toContain("limits how often it can create");
      expect(result.message).toContain("Wait a minute");
    }
  });

  test("an unknown failure code still reads as a failure", () => {
    const result = readOpenRouterConnectReturn(
      "?connect=openrouter&outcome=error&code=who_knows",
    );
    expect(result?.kind).toBe("error");
    if (result?.kind === "error")
      expect(result.message).toContain("did not finish");
  });
});

describe("readHuggingFaceConnectReturn", () => {
  test("an unrelated query string, including an OpenRouter one, is nobody's outcome", () => {
    expect(readHuggingFaceConnectReturn("")).toBeNull();
    expect(
      readHuggingFaceConnectReturn("?connect=openrouter&outcome=connected"),
    ).toBeNull();
  });

  test("a connected return carries the bench, with no routine list yet — that comes from completeSetup", () => {
    expect(
      readHuggingFaceConnectReturn(
        "?connect=huggingface&outcome=connected&tenantSlug=ada-user1",
      ),
    ).toEqual({
      kind: "connected",
      tenantSlug: "ada-user1",
    });
  });

  test("the not_configured code maps to its own copy", () => {
    const result = readHuggingFaceConnectReturn(
      "?connect=huggingface&outcome=error&code=not_configured",
    );
    expect(result?.kind).toBe("error");
    if (result?.kind === "error")
      expect(result.message).toContain("Paste a token instead");
  });
});

describe("the OpenRouter connect card", () => {
  const renderOnboardingAt = (url: string) => {
    window.history.replaceState(null, "", url);
    try {
      return renderToStaticMarkup(
        <App
          path={ONBOARDING_PATH}
          navigate={noop}
          session={signedIn}
          onSignedIn={noop}
          onSignOut={noop}
          onRetry={noop}
        />,
      );
    } finally {
      window.history.replaceState(null, "", "/");
    }
  };

  test("the credential phase leads with the one-click connect above the key form", () => {
    const markup = renderOnboardingAt(
      "/onboarding?connect=openrouter&outcome=error&code=state_expired",
    );

    expect(markup).toContain("Connect with OpenRouter");
    expect(markup).toContain("/api/onboarding/oauth/openrouter/start");
    expect(markup.indexOf("onboarding-connect-card")).toBeLessThan(
      markup.indexOf("onboarding-credential-form"),
    );
    // The failed round trip's reason is spelled out in the same phase.
    expect(markup).toContain("took too long");
  });

  test("a connected return shows the finishing-setup progress state, not a fabricated done checklist", () => {
    // Before `completeSetup` resolves, the wizard must never claim the
    // routines already ran — that was the bug this split fixes: the
    // OAuth callback only proved and stored the key, so the checklist
    // showing "confirmed running" before the deploy step even started
    // would be a lie.
    const markup = renderOnboardingAt(
      "/onboarding?connect=openrouter&outcome=connected&tenantSlug=ada-user1",
    );

    expect(markup).toContain("Setting up your workbench");
    expect(markup).not.toContain("Your workbench is ready");
  });

  test("a connected return finishes setup and lands on the running-routines ending once completeSetup reports seeded", async () => {
    globalThis.fetch = (async (url: string) => {
      if (url === "/api/onboarding/complete-setup") {
        return json({
          kind: "seeded",
          tenantSlug: "ada-user1",
          workflows: ["echo", "assistant"],
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as unknown as typeof fetch;

    window.history.replaceState(
      null,
      "",
      "/onboarding?connect=openrouter&outcome=connected&tenantSlug=ada-user1",
    );
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      act(() => {
        root.render(
          <App
            path={ONBOARDING_PATH}
            navigate={noop}
            session={signedIn}
            onSignedIn={noop}
            onSignOut={noop}
            onRetry={noop}
          />,
        );
      });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });

      expect(container.textContent).toContain(
        "Your workbench is ready",
      );
      expect(container.textContent).toContain("Echo routine");
      expect(container.textContent).toContain("Myra routine");
    } finally {
      act(() => root.unmount());
      container.remove();
      window.history.replaceState(null, "", "/");
    }
  });

  test("a seeded response carrying a tenant id lands on the optional Connect your tools step first, and Skip for now reaches the routines ending", async () => {
    globalThis.fetch = (async (url: string) => {
      if (url === "/api/onboarding/complete-setup") {
        return json({
          kind: "seeded",
          tenantId: "ten_ada",
          tenantSlug: "ada-user1",
          workflows: ["echo", "assistant"],
        });
      }
      if (url === "/api/tenants/ten_ada/credentials") {
        return json({ data: [], nextCursor: null });
      }
      if (url === "/api/tenants/ten_ada/providers") {
        return json({ data: [], nextCursor: null });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as unknown as typeof fetch;

    window.history.replaceState(
      null,
      "",
      "/onboarding?connect=openrouter&outcome=connected&tenantSlug=ada-user1",
    );
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      act(() => {
        root.render(
          <App
            path={ONBOARDING_PATH}
            navigate={noop}
            session={signedIn}
            onSignedIn={noop}
            onSignOut={noop}
            onRetry={noop}
          />,
        );
      });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });

      expect(container.textContent).toContain("Connect your tools");
      expect(container.textContent).not.toContain(
        "Your workbench is ready",
      );

      const skipButton = Array.from(container.querySelectorAll("button")).find(
        (button) => button.textContent === "Skip for now",
      );
      expect(skipButton).toBeDefined();
      act(() => {
        skipButton?.click();
      });

      expect(container.textContent).toContain(
        "Your workbench is ready",
      );
    } finally {
      act(() => root.unmount());
      container.remove();
      window.history.replaceState(null, "", "/");
    }
  });

  test("a connected return falls back to the credential phase, not a dead end, when completeSetup reports unseeded", async () => {
    // The degraded-but-correct path: the pending-seed cookie can be
    // missing (a loser duplicate-callback response the browser never
    // applied, a cookie that already expired) even though the
    // credential itself connected fine. `completeSetup` answers
    // `unseeded` — not an error — and the wizard must land somewhere a
    // person can actually finish from, never stuck on the spinner or a
    // blank state.
    globalThis.fetch = (async (url: string) => {
      if (url === "/api/onboarding/complete-setup") {
        return json({ kind: "unseeded" });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as unknown as typeof fetch;

    window.history.replaceState(
      null,
      "",
      "/onboarding?connect=openrouter&outcome=connected&tenantSlug=ada-user1",
    );
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      act(() => {
        root.render(
          <App
            path={ONBOARDING_PATH}
            navigate={noop}
            session={signedIn}
            onSignedIn={noop}
            onSignOut={noop}
            onRetry={noop}
          />,
        );
      });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });

      // Lands back on the credential step, reading as unfinished — the
      // same "finish setting up" copy a returning bench_unseeded member
      // gets — with no error banner and no pre-satisfied skip option,
      // since nothing here actually proved a working key is in place.
      expect(container.textContent).toContain(
        "Finish setting up your workbench",
      );
      expect(container.textContent).not.toContain(
        "A working key is already in place",
      );
      expect(container.textContent).not.toContain("That key didn't work");
      // Still offers the one-click connect and the paste-a-key form —
      // never a dead end.
      expect(container.textContent).toContain("Connect with OpenRouter");
    } finally {
      act(() => root.unmount());
      container.remove();
      window.history.replaceState(null, "", "/");
    }
  });

  test("a stale connect error is superseded when the account turns out to already be fully seeded", async () => {
    // The belt to the idempotent-duplicate-callback fix's suspenders: a
    // browser landing on the credential phase's stale `state_expired`
    // error must not stay stuck there once a real check shows the
    // connect actually succeeded — it lands on the same finished state
    // as a fresh connect would.
    globalThis.fetch = (async (url: string) => {
      if (url === "/api/onboarding/provision") {
        return json({ kind: "existing-member", seeded: true });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as unknown as typeof fetch;

    window.history.replaceState(
      null,
      "",
      "/onboarding?connect=openrouter&outcome=error&code=state_expired",
    );
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      act(() => {
        root.render(
          <App
            path={ONBOARDING_PATH}
            navigate={noop}
            session={signedIn}
            onSignedIn={noop}
            onSignOut={noop}
            onRetry={noop}
          />,
        );
      });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });

      expect(container.textContent).toContain("Your workbench is ready");
      expect(container.textContent).toContain("Meet Myra");
      expect(container.textContent).not.toContain("took too long");
    } finally {
      act(() => root.unmount());
      container.remove();
      window.history.replaceState(null, "", "/");
    }
  });
});

describe("the provider picker's primary row and secondary expander", () => {
  const renderCredentialPhase = () => {
    window.history.replaceState(
      null,
      "",
      "/onboarding?connect=openrouter&outcome=error&code=state_expired",
    );
    try {
      return renderToStaticMarkup(
        <App
          path={ONBOARDING_PATH}
          navigate={noop}
          session={signedIn}
          onSignedIn={noop}
          onSignOut={noop}
          onRetry={noop}
        />,
      );
    } finally {
      window.history.replaceState(null, "", "/");
    }
  };

  test("the primary six render in the owner's exact order, ahead of the expander", () => {
    const markup = renderCredentialPhase();
    // Search only from the radiogroup onward — "OpenRouter" also appears
    // in the one-click connect card above the picker.
    const pickerMarkup = markup.slice(
      markup.indexOf('aria-label="Inference provider"'),
    );
    const labels = [
      "OpenAI",
      "Anthropic",
      "Google",
      "xAI",
      "OpenRouter",
      "Opencode Zen",
      "More providers",
    ];
    const positions = labels.map((label) => pickerMarkup.indexOf(label));

    expect(positions.every((index) => index >= 0)).toBe(true);
    const isStrictlyIncreasing = positions.every(
      (position, i) => i === 0 || position > (positions[i - 1] ?? -Infinity),
    );
    expect(isStrictlyIncreasing).toBe(true);
  });

  test("groq, deepseek, and mistral still render, fully functional, inside the expander", () => {
    const markup = renderCredentialPhase();
    // Search only from the radiogroup onward — provider names also appear
    // in the one-click connect cards' copy above the picker.
    const pickerMarkup = markup.slice(
      markup.indexOf('aria-label="Inference provider"'),
    );
    const moreIndex = pickerMarkup.indexOf("More providers");

    for (const label of ["Groq", "DeepSeek", "Mistral"]) {
      const labelIndex = pickerMarkup.indexOf(label);
      expect(labelIndex).toBeGreaterThan(moreIndex);
    }
    // Still real radio buttons, not disabled or decorative.
    expect(markup).toContain('role="radio"');
  });

  test("the expander is collapsed by default — anthropic is the initial selection", () => {
    const markup = renderCredentialPhase();
    expect(markup).toContain('class="onboarding-provider-more"');
    expect(markup).not.toMatch(/class="onboarding-provider-more" open/);
  });
});

describe("the Hugging Face connect card", () => {
  const renderOnboardingAt = (url: string) => {
    window.history.replaceState(null, "", url);
    try {
      return renderToStaticMarkup(
        <App
          path={ONBOARDING_PATH}
          navigate={noop}
          session={signedIn}
          onSignedIn={noop}
          onSignOut={noop}
          onRetry={noop}
        />,
      );
    } finally {
      window.history.replaceState(null, "", "/");
    }
  };

  test("sits below the OpenRouter card, above the key form", () => {
    const markup = renderOnboardingAt(
      "/onboarding?connect=huggingface&outcome=error&code=not_configured",
    );

    expect(markup).toContain("Sign in with Hugging Face");
    expect(markup).toContain("/api/onboarding/oauth/huggingface/start");
    expect(markup.indexOf("Connect with OpenRouter")).toBeLessThan(
      markup.indexOf("Sign in with Hugging Face"),
    );
    expect(markup.indexOf("Sign in with Hugging Face")).toBeLessThan(
      markup.indexOf("onboarding-credential-form"),
    );
    expect(markup).toContain("Paste a token instead");
  });

  test("a connected return shows the finishing-setup progress state, not a fabricated done checklist", () => {
    const markup = renderOnboardingAt(
      "/onboarding?connect=huggingface&outcome=connected&tenantSlug=ada-user1",
    );

    expect(markup).toContain("Setting up your workbench");
    expect(markup).not.toContain("Your workbench is ready");
  });

  test("a connected return finishes setup and lands on the running-routines ending once completeSetup reports seeded", async () => {
    globalThis.fetch = (async (url: string) => {
      if (url === "/api/onboarding/complete-setup") {
        return json({
          kind: "seeded",
          tenantSlug: "ada-user1",
          workflows: ["echo", "assistant"],
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as unknown as typeof fetch;

    window.history.replaceState(
      null,
      "",
      "/onboarding?connect=huggingface&outcome=connected&tenantSlug=ada-user1",
    );
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      act(() => {
        root.render(
          <App
            path={ONBOARDING_PATH}
            navigate={noop}
            session={signedIn}
            onSignedIn={noop}
            onSignOut={noop}
            onRetry={noop}
          />,
        );
      });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });

      expect(container.textContent).toContain(
        "Your workbench is ready",
      );
      expect(container.textContent).toContain("Echo routine");
      expect(container.textContent).toContain("Myra routine");
    } finally {
      act(() => root.unmount());
      container.remove();
      window.history.replaceState(null, "", "/");
    }
  });
});

describe("OnboardingPage resuming a bench_unseeded account", () => {
  const noop = () => undefined;
  const settle = () =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  afterEach(() => {
    if (root !== null) act(() => root?.unmount());
    container?.remove();
    container = null;
    root = null;
  });

  test("an existing member with seeded: false lands on the credential step reading as unfinished, not pre-satisfied", async () => {
    // No naming step (CL-6089) — provisioning fires automatically, under
    // a default name, the moment the wizard mounts.
    globalThis.fetch = (async () =>
      json({
        kind: "existing-member",
        seeded: false,
      })) as unknown as typeof fetch;

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root?.render(
        createElement(NavigationProvider, {
          navigate: noop,
          children: createElement(OnboardingPage, {
            user: { id: "user_1", name: "Ada", email: "ada@example.com" },
          }),
        }),
      );
    });
    await settle();

    // The wizard reads this account as still needing a working
    // credential — never "a working key is already in place", the copy
    // a fully seeded existing member gets.
    expect(container.textContent).toContain("Finish setting up your workbench");
    expect(container.textContent).not.toContain(
      "A working key is already in place",
    );
  });
});
