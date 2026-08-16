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

async function trySignIn(
  api: ApiCall,
  args: { email: string; password: string },
): Promise<Session | { failedStatus: number }> {
  const signIn = await api("POST", "/api/auth/sign-in/email", {
    email: args.email,
    password: args.password,
  });
  if (signIn.status === 200) {
    const parsed = parseAs(AuthResponse, signIn.data, "sign-in response");
    return {
      cookies: signIn.cookies,
      userId: parsed.user?.id ?? "",
      signedUp: false,
    };
  }
  return { failedStatus: signIn.status };
}

/**
 * Sign the administrator in — sign-in only, never sign-up. For callers
 * that must never mint an account (e.g. the env-key auto-plant, which
 * runs unattended at boot and must not self-provision the default
 * admin credential on a virgin, open-signup database), this is the only
 * safe entry point.
 */
export async function signIn(
  api: ApiCall,
  args: { email: string; password: string },
): Promise<Session> {
  const result = await trySignIn(api, args);
  if (!("failedStatus" in result)) return result;
  throw new CliError(
    `sign-in failed for ${args.email} (status ${result.failedStatus})`,
    "verify HUB_ADMIN_EMAIL/HUB_ADMIN_PASSWORD match an existing admin account",
  );
}

/**
 * Sign the administrator in, or sign up when the account does not exist
 * yet. Sign-in is tried first so `WORKBENCH_SIGNUP=closed` still works
 * for an existing admin (the product gate only blocks self-serve
 * registration). Fresh sign-up is allowed only when the hub is open;
 * a closed hub with no matching account is reported with the env fix.
 */
export async function authenticate(
  api: ApiCall,
  args: { email: string; password: string },
): Promise<Session> {
  const name = args.email.split("@")[0] ?? args.email;

  const signInAttempt = await trySignIn(api, args);
  if (!("failedStatus" in signInAttempt)) return signInAttempt;

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

  // better-auth answers 422 when the address is already registered —
  // that means the password did not match on sign-in above.
  if (signUp.status === 422) {
    throw new CliError(
      `${args.email} already exists on the hub but HUB_ADMIN_PASSWORD does not match it (sign-in returned ${signInAttempt.failedStatus})`,
      "set HUB_ADMIN_PASSWORD to the password this account was created with, or use a fresh HUB_ADMIN_EMAIL, then re-run the command",
    );
  }

  const closed =
    signUp.status === 403 &&
    signUp.data !== null &&
    typeof signUp.data === "object" &&
    "error" in signUp.data &&
    (signUp.data as { error: unknown }).error === "signup_closed";
  if (closed) {
    throw new CliError(
      `self-serve signup is closed and ${args.email} does not exist yet`,
      "set WORKBENCH_SIGNUP=open in .env, restart the hub, re-run this command once to create the admin, then set WORKBENCH_SIGNUP=closed again if you want a closed deploy",
    );
  }

  throw new CliError(
    `the hub rejected sign-up for ${args.email} with status ${signUp.status}: ${JSON.stringify(signUp.data)}`,
    "check the hub logs for the underlying failure, fix it, then re-run the command",
  );
}
