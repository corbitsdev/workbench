// CL-6369: the URL bar is the source of truth for where you are.
// `TestRoot` mirrors `main.tsx`'s `Root` history wiring (same pattern as
// `test/auth.test.tsx`'s `ProbedApp`) so these tests drive real
// `pushState`/`popstate` traffic instead of asserting against a bare
// `navigate` prop.

import { ThemeProvider } from "@corbits/react-ui";
import { afterEach, describe, expect, test } from "bun:test";
import { act, useCallback, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";

import { App } from "../src/app";
import { validatedNextPath } from "../src/login-next";
import type { SessionState, SessionUser } from "../src/session";

const realFetch = globalThis.fetch;

function stubEmptyFetch(): void {
  globalThis.fetch = ((_input: RequestInfo | URL, _init?: RequestInit) =>
    Promise.resolve(
      new Response(JSON.stringify({ data: [], nextCursor: null }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    )) as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = realFetch;
  window.history.replaceState(null, "", "/");
});

const user: SessionUser = {
  id: "user_1",
  name: "Ada",
  email: "ada@example.com",
};

/** Set by `TestRoot` on every render so a test can drive the exact
 * `handleSignedIn` wiring `main.tsx`'s `Root` gives `AuthScreen` — reading
 * `next=` off the live URL at call time — without simulating a real
 * `LoginForm` submission end to end. */
let capturedHandleSignedIn: ((user: SessionUser) => void) | null = null;

function TestRoot({
  initialSession,
}: {
  readonly initialSession: SessionState;
}) {
  const [path, setPath] = useState(window.location.pathname);
  useEffect(() => {
    const onPopState = () => setPath(window.location.pathname);
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);
  const navigate = useCallback((to: string) => {
    window.history.pushState(null, "", to);
    setPath(new URL(to, window.location.origin).pathname);
  }, []);
  const [session, setSession] = useState<SessionState>(initialSession);
  const handleSignedIn = useCallback(
    (signedInUser: SessionUser) => {
      setSession({ kind: "signed-in", user: signedInUser });
      navigate(validatedNextPath(window.location.search));
    },
    [navigate],
  );
  useEffect(() => {
    capturedHandleSignedIn = handleSignedIn;
    return () => {
      capturedHandleSignedIn = null;
    };
  }, [handleSignedIn]);
  return (
    <ThemeProvider>
      <App
        path={path}
        navigate={navigate}
        session={session}
        onSignedIn={handleSignedIn}
        onSignOut={() => setSession({ kind: "signed-out" })}
        onRetry={() => undefined}
      />
    </ThemeProvider>
  );
}

async function flush(): Promise<void> {
  for (let count = 0; count < 5; count += 1) {
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function mount(
  initialPath: string,
  initialSession: SessionState,
): Promise<{ container: HTMLDivElement; root: Root }> {
  stubEmptyFetch();
  window.history.replaceState(null, "", initialPath);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<TestRoot initialSession={initialSession} />);
  });
  await flush();
  return { container, root };
}

function unmount(container: HTMLDivElement, root: Root): void {
  act(() => root.unmount());
  container.remove();
}

describe("unauthenticated deep links redirect to /login with next=", () => {
  for (const path of ["/files", "/agents", "/skills", "/insights"]) {
    test(`${path} bounces to /login?next=${encodeURIComponent(path)}`, async () => {
      const { container, root } = await mount(path, { kind: "signed-out" });
      expect(window.location.pathname).toBe("/login");
      expect(window.location.search).toBe(`?next=${encodeURIComponent(path)}`);
      expect(container.textContent).toContain("Welcome back");
      unmount(container, root);
    });
  }
});

describe("login round trip", () => {
  test("signing in from a next= redirect returns to that path", async () => {
    const { container, root } = await mount("/files", { kind: "signed-out" });
    expect(window.location.pathname).toBe("/login");
    expect(window.location.search).toBe("?next=%2Ffiles");

    // Drives the exact `handleSignedIn` wiring `main.tsx`'s `Root` gives
    // `AuthScreen` — reading `next=` off the live URL — without simulating
    // a full `LoginForm` submission end to end.
    await act(async () => {
      capturedHandleSignedIn?.(user);
    });
    await flush();
    expect(window.location.pathname).toBe("/files");
    unmount(container, root);
  });

  test("already-authed visits to /login bounce home", async () => {
    const { container, root } = await mount("/login?next=%2Ffiles", {
      kind: "signed-in",
      user,
    });
    expect(window.location.pathname).toBe("/");
    unmount(container, root);
  });
});

describe("authed deep links render their own page", () => {
  const cases: readonly [string, string][] = [
    ["/files", "Files"],
    ["/agents", "Agents"],
    ["/skills", "Skills"],
    ["/insights", "Insights"],
  ];
  for (const [path, label] of cases) {
    test(`${path} renders while signed in, URL unchanged`, async () => {
      const { container, root } = await mount(path, {
        kind: "signed-in",
        user,
      });
      expect(window.location.pathname).toBe(path);
      expect(container.textContent).toContain(label);
      unmount(container, root);
    });
  }

  test("a workbench deep link stays on its own URL", async () => {
    const { container, root } = await mount("/w/ch_1", {
      kind: "signed-in",
      user,
    });
    expect(window.location.pathname).toBe("/w/ch_1");
    unmount(container, root);
  });
});

describe("back and forward move through real history", () => {
  test("three navigations, then back/back/forward land on the right URL", async () => {
    const { container, root } = await mount("/files", {
      kind: "signed-in",
      user,
    });
    await act(async () => {
      window.history.pushState(null, "", "/agents");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await flush();
    await act(async () => {
      window.history.pushState(null, "", "/skills");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await flush();
    expect(window.location.pathname).toBe("/skills");

    await act(async () => {
      window.history.back();
    });
    await flush();
    expect(window.location.pathname).toBe("/agents");

    await act(async () => {
      window.history.back();
    });
    await flush();
    expect(window.location.pathname).toBe("/files");

    await act(async () => {
      window.history.forward();
    });
    await flush();
    expect(window.location.pathname).toBe("/agents");

    unmount(container, root);
  });
});
