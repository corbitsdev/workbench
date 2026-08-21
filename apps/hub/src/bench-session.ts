// The one thing a background loop cannot inherit: a session. The bench
// provisioner (`@workbench/onboarding`'s `createBenchProvisioner`) runs
// with no request to borrow cookies from, yet everything it drives —
// `seedTenant`'s asset creates, deployments, grants, and the git push
// underneath them — speaks the hub's own HTTP API as the bench's owner.
// This mints that session in-process.
//
// It has to be the user's own session, not an administrator's: the hub
// resolves a tenant by looking up a principal for (tenantId, user), and
// an account with no principal in that tenant is refused outright. A
// parent-org admin does not inherit rights over a child bench — RBAC
// resolves grants within a single tenant — so "just use the operator
// account" would 403 on every call. The owner's own session is the only
// identity that can provision their bench, which is also the honest
// one: the work is theirs, done on their behalf, and it shows up in the
// session table as such (tagged by user agent, so these are greppable
// and never mistaken for a human sign-in).
//
// Sessions are cached per user and re-minted well before expiry, so a
// drain tick every few seconds does not write a session row every few
// seconds.

import { makeSignature } from "better-auth/crypto";
import type { SessionForUser } from "@workbench/onboarding";

/** Re-mint this far ahead of a cached session's own expiry, so a long
 * provisioning pass can never have its session expire mid-flight. */
const REMINT_LEAD_MS = 60 * 60 * 1000;

const PROVISIONER_USER_AGENT = "workbench-bench-provisioner";

type MintedSession = {
  readonly cookies: string[];
  readonly expiresAtMs: number;
};

/**
 * The better-auth surface this needs, named structurally so the wiring
 * is testable without standing up a whole auth instance.
 */
export type BenchSessionAuth = {
  $context: Promise<{
    secret: string;
    authCookies: { sessionToken: { name: string } };
    internalAdapter: {
      createSession(
        userId: string,
        dontRememberMe?: boolean,
        override?: Record<string, unknown>,
      ): Promise<{ token: string; expiresAt: Date } | null>;
    };
  }>;
};

/**
 * Builds the `sessionFor` seam the bench provisioner takes. Returns the
 * bare `name=value` cookie pairs `ApiCall` sends, signed exactly the way
 * better-auth's own cookie writer signs them — the same HMAC helper the
 * library uses, rather than a hand-rolled copy that could drift from the
 * verifier.
 *
 * `undefined` means "no session could be minted right now" (an account
 * since deleted, an auth backend briefly unavailable). The provisioner
 * treats that as a reason to hold the bench for a later pass, never as a
 * reason to discard its pending work.
 */
export function createBenchSessionMinter(args: {
  auth: BenchSessionAuth;
  log: (line: string) => void;
  now?: () => number;
}): SessionForUser {
  const now = args.now ?? Date.now;
  const cache = new Map<string, MintedSession>();

  return async ({ userId }) => {
    const cached = cache.get(userId);
    if (cached !== undefined && cached.expiresAtMs - REMINT_LEAD_MS > now()) {
      return cached.cookies;
    }

    try {
      const context = await args.auth.$context;
      const session = await context.internalAdapter.createSession(
        userId,
        true,
        { userAgent: PROVISIONER_USER_AGENT },
      );
      if (session === null) {
        cache.delete(userId);
        return undefined;
      }

      const signature = await makeSignature(session.token, context.secret);
      const value = encodeURIComponent(`${session.token}.${signature}`);
      const cookies = [`${context.authCookies.sessionToken.name}=${value}`];
      cache.set(userId, {
        cookies,
        expiresAtMs: session.expiresAt.getTime(),
      });
      return cookies;
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      args.log(
        `could not mint a provisioning session for user ${userId}: ${message}`,
      );
      cache.delete(userId);
      return undefined;
    }
  };
}
