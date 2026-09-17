// The auth gate, tested at our wiring: the session probe and the
// email+password calls are the only fetches the signed-out app knows how to
// make, and the signed-out tree contains the auth screen instead of any
// screen that talks to the hub.

import { ThemeProvider } from "@corbits/react-ui";
import { afterEach, describe, expect, test } from "bun:test";
import { useCallback, useEffect, useState } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";

import { App } from "../src/app";
import { AuthScreen } from "../src/auth-screen";
import { SOCIAL_SIGN_IN_PROVIDERS, fetchSession, signIn, signOut, signUp } from "../src/session";
import type { SessionState } from "../src/session";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

type RecordedCall = { readonly path: string; readonly init?: RequestInit };

function stubFetch(
  respond: (path: string) => Response = () => {
    throw new Error("unexpected fetch");
  },
): RecordedCall[] {
  const calls: RecordedCall[] = [];
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const path = typeof input === "string" ? input : new URL(String(input)).pathname;
    calls.push(init === undefined ? { path } : { path, init });
    return Promise.resolve(respond(path));
  }) as typeof fetch;
  return calls;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const user = { id: "user_1", name: "ada", email: "ada@example.com" };

const noop = () => undefined;

function renderApp(session: SessionState, path = "/"): string {
  return renderToStaticMarkup(
    <ThemeProvider>
      <App
        path={path}
        navigate={noop}
        session={session}
        onSignedIn={noop}
        onSignOut={noop}
        onRetry={noop}
      />
    </ThemeProvider>,
  );
}

describe("session probe", () => {
  test("a null body means signed out, via the one auth endpoint", async () => {
    const calls = stubFetch(() => json(null));
    const state = await fetchSession();
    expect(state).toEqual({ kind: "signed-out" });
    expect(calls.map((call) => call.path)).toEqual(["/api/auth/get-session"]);
  });

  test("a session body means signed in", async () => {
    stubFetch(() => json({ session: { id: "sess_1" }, user }));
    const state = await fetchSession();
    expect(state).toEqual({ kind: "signed-in", user });
  });

  test("a hub failure is an error state, not a sign-out", async () => {
    stubFetch(() => json({ message: "boom" }, 500));
    const state = await fetchSession();
    expect(state.kind).toBe("error");
  });

  // a session body that parses as JSON but carries no usable
  // `user` (the shape a hub restarted against an empty DB, or a cookie
  // for a since-deleted user, can answer with) must still land on login
  // — never the "connection lost" error screen, which would strand the
  // app in a broken half-state instead of the auth screen.
  test("a session body with no user means signed out, not a connectivity error", async () => {
    stubFetch(() => json({ session: { id: "sess_1" } }));
    const state = await fetchSession();
    expect(state).toEqual({ kind: "signed-out" });
  });
});

/** Mirrors `main.tsx`'s `Root`'s own probe-on-mount wiring, minus
 * provisioning — the minimum needed to prove a real DOM mount, driven by
 * the real `fetchSession`, never renders the shell for an invalid session.
 * `/login` is a real route now: an invalid session redirects
 * there rather than swapping in the auth screen at whatever path was
 * requested, so this mounts a real `navigate` to follow that redirect. */
function ProbedApp() {
  const [path, setPath] = useState("/");
  const [session, setSession] = useState<SessionState>({ kind: "loading" });
  const navigate = useCallback((to: string) => {
    setPath(new URL(to, "http://localhost").pathname);
  }, []);
  useEffect(() => {
    void fetchSession().then(setSession);
  }, []);
  return (
    <ThemeProvider>
      <App
        path={path}
        navigate={navigate}
        session={session}
        onSignedIn={noop}
        onSignOut={noop}
        onRetry={noop}
      />
    </ThemeProvider>
  );
}

describe("an invalid session always lands on login", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  afterEach(() => {
    globalThis.fetch = realFetch;
    if (root !== null) {
      act(() => root?.unmount());
      root = null;
    }
    if (container !== null) {
      container.remove();
      container = null;
    }
  });

  test("a null session probe renders the login screen, never the shell", async () => {
    stubFetch(() => json(null));
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(<ProbedApp />);
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(container.querySelector('[data-testid="shell-sidebar"]')).toBeNull();
    expect(container.textContent).toContain("Welcome back");
  });
});

describe("email and password calls", () => {
  test("sign-in posts credentials to better-auth's endpoint", async () => {
    const calls = stubFetch(() => json({ token: "t", user }));
    const result = await signIn("ada@example.com", "hunter22");
    expect(result).toEqual({ ok: true, user });
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call?.path).toBe("/api/auth/sign-in/email");
    expect(call?.init?.method).toBe("POST");
    expect(JSON.parse(String(call?.init?.body))).toEqual({
      email: "ada@example.com",
      password: "hunter22",
    });
  });

  test("sign-up posts a name derived from the address", async () => {
    const calls = stubFetch(() => json({ token: "t", user }));
    const result = await signUp("ada@example.com", "hunter22");
    expect(result).toEqual({ ok: true, user });
    expect(calls[0]?.path).toBe("/api/auth/sign-up/email");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      name: "ada",
      email: "ada@example.com",
      password: "hunter22",
    });
  });

  test("a rejected sign-in surfaces the hub's message", async () => {
    stubFetch(() => json({ message: "Invalid email or password" }, 401));
    const result = await signIn("ada@example.com", "wrong");
    expect(result).toEqual({
      ok: false,
      message: "Invalid email or password",
    });
  });

  test("sign-out posts to better-auth's endpoint", async () => {
    const calls = stubFetch(() => json({ success: true }));
    await signOut();
    expect(calls.map((call) => call.path)).toEqual(["/api/auth/sign-out"]);
  });
});

describe("the gate", () => {
  test("signed out at /login renders the auth screen and fires no authenticated fetch", () => {
    const calls = stubFetch();
    const markup = renderApp({ kind: "signed-out" }, "/login");
    expect(calls).toHaveLength(0);
    expect(markup).toContain("Email");
    expect(markup).toContain("Password");
    expect(markup).not.toContain("aria-current");
    expect(markup).not.toContain("/api/me");
    expect(markup).not.toContain("Sign out");
  });

  test("signed in renders the shell with the sidebar and the avatar's account menu trigger", () => {
    const markup = renderApp({ kind: "signed-in", user });
    // The one sidebar plus the account affordance — a menu (weekly usage,
    // Settings, feedback, Log out), not a plain link straight to settings
    // (grown to the reference shape in).
    expect(markup).toContain('data-testid="shell-sidebar"');
    expect(markup).toContain("shell-sidebar-account-btn");
    expect(markup).toContain('aria-label="ada · Account menu"');
    expect(markup).not.toContain("user_1");
  });

  test("loading and error are their own screens, not a broken shell", () => {
    expect(renderApp({ kind: "loading" })).toContain("Getting your workbench ready");
    const markup = renderApp({ kind: "error", message: "socket hang up" });
    expect(markup).toContain("socket hang up");
    expect(markup).toContain("Try again");
  });
});

// Stock Interchange exposes no sign-in discovery endpoint, so the buttons
// come from client config: the providers this client knows how to draw.
// The hub still decides which of them actually work (better-auth only
// wires the credential pairs it was given); an unconfigured click surfaces
// better-auth's own error on the form, never a new endpoint.
describe("social sign-in buttons", () => {
  test("the client config lists the providers the sign-in screen offers", () => {
    expect([...SOCIAL_SIGN_IN_PROVIDERS].sort()).toEqual(["github", "google"]);
  });

  test("the auth screen draws every client-configured provider button with no fetch", () => {
    const calls = stubFetch();
    const markup = renderToStaticMarkup(<AuthScreen onSignedIn={noop} />);
    expect(calls).toHaveLength(0);
    expect(markup).toContain("Continue with Google");
    expect(markup).toContain("Continue with GitHub");
  });

  // Keeper: stock Interchange exposes no sign-in discovery endpoint, so the
  // buttons always render and the hub decides which providers work — an
  // unconfigured click must surface better-auth's own message on the form.
  test("a failed social sign-in surfaces better-auth's message on the form", async () => {
    const calls = stubFetch(() =>
      json({ message: "Social sign-in is not configured for this provider" }, 400),
    );
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(<AuthScreen onSignedIn={noop} />);
      });
      const button = [...container.querySelectorAll("button")].find(
        (element) => element.textContent === "Continue with Google",
      );
      expect(button).toBeDefined();
      await act(async () => {
        button?.click();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(calls.map((call) => call.path)).toEqual(["/api/auth/sign-in/social"]);
      expect(container.textContent).toContain("Social sign-in is not configured for this provider");
    } finally {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    }
  });
});

describe("auth screen modes", () => {
  test("sign-in leads, with creating an account as the toggle", () => {
    const markup = renderToStaticMarkup(<AuthScreen onSignedIn={noop} />);
    expect(markup).toContain("Welcome back");
    expect(markup).toContain("Create an account");
  });
});
