import { afterEach, describe, expect, test } from "bun:test";

import { signIn, signInSocial, signUp } from "./session";

describe("rate-limited auth responses", () => {
  const realFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  function stub429(retryAfterSeconds: string | null): void {
    globalThis.fetch = ((_input: RequestInfo | URL, _init?: RequestInit) =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            message: "Too many requests. Please try again later.",
          }),
          {
            status: 429,
            headers: {
              "content-type": "application/json",
              ...(retryAfterSeconds === null
                ? {}
                : { "X-Retry-After": retryAfterSeconds }),
            },
          },
        ),
      )) as typeof fetch;
  }

  test("signIn surfaces the retry countdown from X-Retry-After in consumer language", async () => {
    stub429("30");
    const result = await signIn("alice@example.com", "hunter2");
    expect(result).toEqual({
      ok: false,
      message: "Too many sign-in attempts. Try again in 30 seconds.",
    });
  });

  test("signUp shares the same 429 handling as signIn — same underlying bucket", async () => {
    stub429("5");
    const result = await signUp("alice@example.com", "hunter2");
    expect(result).toEqual({
      ok: false,
      message: "Too many sign-in attempts. Try again in 5 seconds.",
    });
  });

  test("falls back to a generic wait message when no retry countdown is given", async () => {
    stub429(null);
    const result = await signIn("alice@example.com", "hunter2");
    expect(result).toEqual({
      ok: false,
      message: "Too many sign-in attempts. Please wait a moment and try again.",
    });
  });

  test("signInSocial gets the same consumer-language 429 message", async () => {
    stub429("12");
    const result = await signInSocial("github");
    expect(result).toEqual({
      ok: false,
      message: "Too many sign-in attempts. Try again in 12 seconds.",
    });
  });
});
