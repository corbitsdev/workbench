// Thin fetch boundary against the hub's native HTTP API, plus the
// response-validation and authentication helpers both verbs share.
// Everything network-shaped funnels through `ApiCall` so tests can
// substitute the whole hub with a function.

import { type, type Type } from "arktype";
import { CliError } from "./errors";

export type ApiResult = {
  status: number;
  data: unknown;
  cookies: string[];
};

export type ApiCall = (
  method: string,
  path: string,
  body?: unknown,
  cookies?: string[],
) => Promise<ApiResult>;

/**
 * Build the real hub API caller: JSON in, JSON out, with a cookie jar
 * threaded through so better-auth sessions survive across calls. A
 * network-level failure is a fresh-user failure, so it is reported as
 * one: the hub is not running, and the fix is to start it.
 */
export function createHubAPI(
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
): ApiCall {
  return async (method, path, body, cookies = []) => {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (cookies.length > 0) headers["Cookie"] = cookies.join("; ");

    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "manual",
      });
    } catch (cause) {
      throw new CliError(
        `the hub at ${baseUrl} is not reachable (${cause instanceof Error ? cause.message : String(cause)})`,
        "start the stack first — `bun run dev` from the repository root — wait for the hub to report it is serving, then re-run this command",
        { cause },
      );
    }

    const jar = [...cookies];
    for (const setCookie of response.headers.getSetCookie()) {
      const pair = setCookie.split(";")[0];
      if (pair === undefined || !pair.includes("=")) continue;
      const name = pair.split("=")[0];
      const existing = jar.findIndex((c) => c.startsWith(`${name}=`));
      if (existing >= 0) jar[existing] = pair;
      else jar.push(pair);
    }

    let data: unknown = null;
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("json")) data = await response.json();

    return { status: response.status, data, cookies: jar };
  };
}

/**
 * Validate a hub response body against its published schema. A
 * mismatch means the hub and this checkout disagree about the API, and
 * the fix is to bring them back in sync — never to limp on with data
 * of an unknown shape.
 */
export function parseAs<T extends Type>(
  schema: T,
  data: unknown,
  label: string,
): T["infer"] {
  const result = schema(data);
  if (result instanceof type.errors) {
    throw new CliError(
      `the hub returned an unexpected ${label}: ${result.summary}`,
      "the running hub does not match this checkout; restart it from this checkout (`bun run dev`) and re-run the command",
    );
  }
  return result;
}

const AuthResponse = type({ "user?": { id: "string" } });

export type Session = {
  cookies: string[];
  userId: string;
  signedUp: boolean;
};

/**
 * Sign the administrator up, or sign in when the account already
 * exists. better-auth answers 200 on a fresh sign-up and 422 when the
 * address is already registered; anything else is a real fault and is
 * reported instead of being papered over by the sign-in fallback.
 */
export async function authenticate(
  api: ApiCall,
  args: { email: string; password: string },
): Promise<Session> {
  const name = args.email.split("@")[0] ?? args.email;
  const signUp = await api("POST", "/api/auth/sign-up/email", {
    name,
    email: args.email,
    password: args.password,
  });
  if (signUp.status === 200) {
    const parsed = parseAs(AuthResponse, signUp.data, "sign-up response");
    return {
      cookies: signUp.cookies,
      userId: parsed.user?.id ?? "",
      signedUp: true,
    };
  }
  if (signUp.status !== 422) {
    throw new CliError(
      `the hub rejected sign-up for ${args.email} with status ${signUp.status}: ${JSON.stringify(signUp.data)}`,
      "check the hub logs for the underlying failure, fix it, then re-run the command",
    );
  }

  const signIn = await api("POST", "/api/auth/sign-in/email", {
    email: args.email,
    password: args.password,
  });
  if (signIn.status !== 200) {
    throw new CliError(
      `${args.email} already exists on the hub but WORKBENCH_ADMIN_PASSWORD does not match it (sign-in returned ${signIn.status})`,
      "set WORKBENCH_ADMIN_PASSWORD to the password this account was created with, or use a fresh WORKBENCH_ADMIN_EMAIL, then re-run the command",
    );
  }
  const parsed = parseAs(AuthResponse, signIn.data, "sign-in response");
  return {
    cookies: signIn.cookies,
    userId: parsed.user?.id ?? "",
    signedUp: false,
  };
}
