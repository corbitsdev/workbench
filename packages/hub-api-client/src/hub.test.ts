// `authenticate`/`signIn` against a stub hub: signup is ungated in stock
// composition, so no failure path may prescribe a signup env key.
import { describe, expect, test } from "bun:test";

import { HubApiError } from "./errors";
import { authenticate, signIn, type ApiCall, type ApiResult } from "./hub";

function stubApi(
  handler: (method: string, path: string) => ApiResult,
): ApiCall {
  return (method, path) => Promise.resolve(handler(method, path));
}

const signInOk: ApiResult = {
  status: 200,
  data: { user: { id: "user_1" } },
  cookies: ["session=abc"],
};

describe("authenticate", () => {
  test("an existing account signs in without a sign-up call", async () => {
    let signUpCalls = 0;
    const api = stubApi((_, path) => {
      if (path === "/api/auth/sign-up/email") signUpCalls += 1;
      return signInOk;
    });
    const session = await authenticate(api, {
      email: "admin@acme.example",
      password: "secret",
    });
    expect(session).toEqual({
      cookies: ["session=abc"],
      userId: "user_1",
      signedUp: false,
    });
    expect(signUpCalls).toBe(0);
  });

  test("a missing account signs up after sign-in fails", async () => {
    const api = stubApi((_, path) => {
      if (path === "/api/auth/sign-in/email")
        return { status: 401, data: null, cookies: [] };
      return {
        status: 200,
        data: { user: { id: "user_2" } },
        cookies: ["session=def"],
      };
    });
    const session = await authenticate(api, {
      email: "new@acme.example",
      password: "secret",
    });
    expect(session.signedUp).toBe(true);
    expect(session.userId).toBe("user_2");
  });

  test("a 422 sign-up means the address exists with a different password", async () => {
    const api = stubApi((_, path) => {
      if (path === "/api/auth/sign-in/email")
        return { status: 401, data: null, cookies: [] };
      return { status: 422, data: null, cookies: [] };
    });
    const error = await authenticate(api, {
      email: "admin@acme.example",
      password: "wrong",
    }).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(HubApiError);
    expect((error as HubApiError).fix).toMatch(/HUB_ADMIN_PASSWORD/);
  });

  test("a rejected sign-up never prescribes a signup env key", async () => {
    const api = stubApi((_, path) => {
      if (path === "/api/auth/sign-in/email")
        return { status: 401, data: null, cookies: [] };
      return {
        status: 403,
        data: { error: "signup_closed" },
        cookies: [],
      };
    });
    const error = await authenticate(api, {
      email: "new@acme.example",
      password: "secret",
    }).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(HubApiError);
    expect((error as HubApiError).message).not.toMatch(/WORKBENCH_SIGNUP/);
    expect((error as HubApiError).fix).not.toMatch(/WORKBENCH_SIGNUP/);
  });
});

describe("signIn", () => {
  test("sign-in only, never signs up", async () => {
    let signUpCalls = 0;
    const api = stubApi((_, path) => {
      if (path === "/api/auth/sign-up/email") signUpCalls += 1;
      return signInOk;
    });
    const session = await signIn(api, {
      email: "admin@acme.example",
      password: "secret",
    });
    expect(session.signedUp).toBe(false);
    expect(signUpCalls).toBe(0);
  });

  test("a failed sign-in names the admin credential to check", async () => {
    const api = stubApi(() => ({ status: 401, data: null, cookies: [] }));
    const error = await signIn(api, {
      email: "admin@acme.example",
      password: "wrong",
    }).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(HubApiError);
    expect((error as HubApiError).fix).toMatch(/HUB_ADMIN/);
  });
});
