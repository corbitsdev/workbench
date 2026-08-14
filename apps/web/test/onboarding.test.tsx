// The failure path for first-login provisioning: a broken hub call
// must not collapse to "nothing to do". `triggerFirstLoginProvisioning`
// should report it as a distinct error outcome, and the app shell must
// render a full blocking screen for it rather than silently continuing
// into a shell with zero benches.

import { ThemeProvider } from "@corbits/react-ui";
import { afterEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { App } from "../src/app";
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
  // actually shows up: nine cards, one per SupportedCredentialProvider,
  // each with a distinct honest one-liner and a real key-console link.
  test("has one card for every OpenAI-compatible relay plus the direct providers", () => {
    expect(CREDENTIAL_PROVIDERS.map((p) => p.id).sort()).toEqual([
      "anthropic",
      "deepseek",
      "google-genai",
      "groq",
      "huggingface",
      "mistral",
      "openai",
      "opencode-zen",
      "openrouter",
      "xai",
    ]);
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

  test("a provisioned bench with a server seed stays a 'provisioned' outcome — the credential step is not skipped", async () => {
    // Regression guard: a server-side seed (operator-configured key) must
    // not collapse the outcome into `existing-member` or otherwise hide
    // that the bench was just provisioned. The wizard relies on this
    // distinction to render the credential step as pre-satisfied (with a
    // skip option) rather than branching past it entirely.
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
    expect(markup).toContain("Step 1 of 3");
    expect(markup).toContain("Name your workbench");
    expect(markup).toContain("onboarding-progress-track");
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

  test("a seeded return carries the bench and its confirmed routines", () => {
    expect(
      readOpenRouterConnectReturn(
        "?connect=openrouter&outcome=seeded&tenantSlug=ada-user1&workflows=echo,assistant",
      ),
    ).toEqual({
      kind: "seeded",
      tenantSlug: "ada-user1",
      workflows: ["echo", "assistant"],
    });
  });

  test("a seeded return missing its details is an error, never a fabricated success", () => {
    const result = readOpenRouterConnectReturn(
      "?connect=openrouter&outcome=seeded",
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

  test("a rate-limited start maps to its own copy", () => {
    const result = readOpenRouterConnectReturn(
      "?connect=openrouter&outcome=error&code=rate_limited",
    );
    expect(result?.kind).toBe("error");
    if (result?.kind === "error")
      expect(result.message).toContain("Wait a moment");
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
      readHuggingFaceConnectReturn("?connect=openrouter&outcome=seeded"),
    ).toBeNull();
  });

  test("a seeded return carries the bench and its confirmed routines", () => {
    expect(
      readHuggingFaceConnectReturn(
        "?connect=huggingface&outcome=seeded&tenantSlug=ada-user1&workflows=echo,assistant",
      ),
    ).toEqual({
      kind: "seeded",
      tenantSlug: "ada-user1",
      workflows: ["echo", "assistant"],
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

  test("a seeded connect return lands on the running-routines ending", () => {
    const markup = renderOnboardingAt(
      "/onboarding?connect=openrouter&outcome=seeded&tenantSlug=ada-user1&workflows=echo,assistant",
    );

    expect(markup).toContain("Your first routines are running");
    expect(markup).toContain("Echo routine");
    expect(markup).toContain("Myra routine");
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
    const moreIndex = markup.indexOf("More providers");

    for (const label of ["Groq", "DeepSeek", "Mistral"]) {
      const labelIndex = markup.indexOf(label);
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

  test("a seeded connect return lands on the running-routines ending", () => {
    const markup = renderOnboardingAt(
      "/onboarding?connect=huggingface&outcome=seeded&tenantSlug=ada-user1&workflows=echo,assistant",
    );

    expect(markup).toContain("Your first routines are running");
    expect(markup).toContain("Echo routine");
    expect(markup).toContain("Myra routine");
  });
});
