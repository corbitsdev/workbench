// The auth gate, tested at our wiring: the session probe and the
// email+password calls are the only fetches the signed-out app knows how to
// make, and the signed-out tree contains the auth screen instead of any
// screen that talks to the hub.

import { ThemeProvider } from "@corbits/react-ui";
import { afterEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { App } from "../src/app";
import { AuthScreen } from "../src/auth-screen";
import {
  fetchAuthConfig,
  fetchSession,
  signIn,
  signOut,
  signUp,
} from "../src/session";
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
    const path =
      typeof input === "string" ? input : new URL(String(input)).pathname;
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

function renderApp(session: SessionState): string {
  return renderToStaticMarkup(
    <ThemeProvider>
      <App
        path="/"
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
  test("signed out renders the auth screen and fires no authenticated fetch", () => {
    const calls = stubFetch();
    const markup = renderApp({ kind: "signed-out" });
    expect(calls).toHaveLength(0);
    expect(markup).toContain("Email");
    expect(markup).toContain("Password");
    expect(markup).not.toContain("aria-current");
    expect(markup).not.toContain("/api/me");
    expect(markup).not.toContain("Sign out");
  });

  test("signed in renders the shell with the screens and a sign-out control", () => {
    const markup = renderApp({ kind: "signed-in", user });
    expect(markup).toContain("Sign out");
    expect(markup).toContain("ada@example.com");
    // Default land is the Myra channel canvas — no rail destination is current
    // (channel paths are not rail items). Assert the rail and shell still mount.
    expect(markup).toContain('data-slot="sidebar-rail"');
    expect(markup).toContain('data-slot="sidebar-rail-item"');
  });

  test("loading and error are their own screens, not a broken shell", () => {
    expect(renderApp({ kind: "loading" })).toContain("Loading workbench");
    const markup = renderApp({ kind: "error", message: "socket hang up" });
    expect(markup).toContain("socket hang up");
    expect(markup).toContain("Try again");
  });
});

describe("auth config fetch", () => {
  test("a genuinely empty provider list is ready, not unavailable", async () => {
    stubFetch(() => json({ socialProviders: [] }));
    const result = await fetchAuthConfig();
    expect(result).toEqual({ kind: "ready", providers: [] });
  });

  test("a configured provider list is ready", async () => {
    stubFetch(() => json({ socialProviders: ["google"] }));
    const result = await fetchAuthConfig();
    expect(result).toEqual({ kind: "ready", providers: ["google"] });
  });

  test("a non-2xx response is unavailable, not an empty list", async () => {
    stubFetch(() => json({ message: "boom" }, 500));
    const result = await fetchAuthConfig();
    expect(result.kind).toBe("unavailable");
  });

  test("a body that fails the schema is unavailable", async () => {
    stubFetch(() => json({ socialProviders: "not-an-array" }));
    const result = await fetchAuthConfig();
    expect(result.kind).toBe("unavailable");
  });

  test("a network failure is unavailable", async () => {
    globalThis.fetch = ((_input: RequestInfo | URL, _init?: RequestInit) =>
      Promise.reject(new Error("network down"))) as typeof fetch;
    const result = await fetchAuthConfig();
    expect(result).toEqual({ kind: "unavailable", message: "network down" });
  });
});

describe("auth screen modes", () => {
  test("sign-in leads, with creating an account as the toggle", () => {
    const markup = renderToStaticMarkup(<AuthScreen onSignedIn={noop} />);
    expect(markup).toContain("Welcome back");
    expect(markup).toContain("Create an account");
  });
});
