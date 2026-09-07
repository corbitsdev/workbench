// A server-side identity credential for chat's own calls into the hub's
// `/api/tenants/:tenantId/workflows/runs/:runId/mail` route (see
// `./run-trigger-client.ts`). That route authenticates a caller through
// `@intx/hub-api`'s ordinary session-cookie path — the right answer for a
// human's browser, but chat's own dispatch (mention fan-out, relaunch
// resends, the mailbox-fanout persist seam) runs with no browser request
// in scope at all and cannot present one.
//
// `@intx/hub-api`'s `GetSession` contract is deliberately pluggable (see
// its own doc comment: "so a third-party identity provider can be
// plugged in"), and `apps/hub` is the one composing it (`getSession` is
// supplied there, not fixed by the vendored package). This module is the
// shared signer/verifier for a short-lived, HMAC-signed token naming the
// principal to authenticate as: chat signs one per trigger call
// (`./run-trigger-client.ts`), and `apps/hub`'s `getSession` verifies it
// before falling through to the real cookie-session path. Neither side
// touches `vendor/intx` — this is host-owned wiring through an
// already-open extension seam, not a fork of the session contract.
//
// The signed identity is a better-auth `user.id` (what `resolveTenant`
// looks up a tenant `principal` by by `refId`), never a raw
// `chat.workbench_launch`/`workflow_run` id — those name a run or a
// room, not an authenticated user.
import { createHmac, timingSafeEqual } from "node:crypto";

const TOKEN_TTL_MS = 30_000;

function sign(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

/**
 * Mint a token asserting `userId` is the caller, valid for
 * `TOKEN_TTL_MS` from `now`. Bound to a real wall-clock deadline rather
 * than being a durable credential — this authenticates one trigger call,
 * not a session a caller could hold onto.
 */
export function signInternalRunTriggerToken(
  secret: string,
  userId: string,
  now: number = Date.now(),
): string {
  const expiresAt = now + TOKEN_TTL_MS;
  const payload = `${userId}.${expiresAt}`;
  return `${payload}.${sign(secret, payload)}`;
}

/**
 * Verify a token minted by `signInternalRunTriggerToken`, returning the
 * asserted `userId` when the signature checks out and the token has not
 * expired, `null` otherwise. Constant-time signature comparison so a
 * caller cannot learn anything about the expected signature from timing.
 */
export function verifyInternalRunTriggerToken(
  secret: string,
  token: string,
  now: number = Date.now(),
): string | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [userId, expiresAtRaw, signature] = parts;
  if (userId === undefined || userId === "") return null;
  if (expiresAtRaw === undefined || signature === undefined) return null;
  const expiresAt = Number(expiresAtRaw);
  if (!Number.isFinite(expiresAt) || expiresAt < now) return null;

  const expected = sign(secret, `${userId}.${expiresAtRaw}`);
  const presented = Buffer.from(signature);
  const wanted = Buffer.from(expected);
  if (presented.length !== wanted.length) return null;
  if (!timingSafeEqual(presented, wanted)) return null;
  return userId;
}
