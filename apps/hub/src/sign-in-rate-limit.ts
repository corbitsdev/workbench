// Account-keyed sign-in attempt limiter (CL-6494, hardened CL-6521).
//
// better-auth's own rate limiter keys solely on client IP (falling back to
// one shared bucket when no IP resolves), configured via
// `advanced.ipAddress` + `rateLimit.customRules`. That key cannot be this
// deployment's sign-in defense: Railway's private networking lets any
// same-project service — including sidecars that run agent-driven shell
// commands — reach this hub directly at `<service>.railway.internal`,
// bypassing Railway's edge entirely. better-auth's `getIPFromHeader` trusts
// a single-value IP header verbatim whenever no `trustedProxies` is
// configured, and Railway's anycast edge publishes no stable CIDR list to
// populate one with. A caller on the private network can therefore send a
// fresh forged IP header on every request and get an independent
// rate-limit bucket each time — a complete bypass of brute-force
// protection, reachable from inside our own trust boundary.
//
// better-auth has no native extension point that fixes this: `customRules`
// can only override a matched path's `window`/`max` (or opt the path out
// entirely via `false`) — it never gets to change the key. `customStorage`
// only ever receives the already-computed `ip|path` key. Neither sees the
// request body, so neither can key on anything but that IP. This limiter
// is therefore deliberately separate from better-auth's engine —
// `index.ts` sets `customRules["/sign-in/email"]` to `false`, fully
// disabling better-auth's native, IP-keyed enforcement for this one path,
// rather than attempting to bend its extension points to a job they don't
// reach. Upstream note: better-auth would need a `customRules` (or
// pre-consume) hook that can see the parsed request body, or override the
// key itself, to express account-keyed limiting natively.
//
// Keyed on the normalized target email instead: that value isn't
// attacker-chosen the way a header is. An attacker rotating IP headers
// still cannot exceed the budget for the one account they're actually
// trying to break into, which is the threat brute-force limiting exists to
// stop. Client IP is deliberately not composed into the key: this
// deployment has no way to tell an edge-forwarded request from one that
// arrived over the private network with a forged header, so a
// header-derived IP is not a genuinely trustworthy signal here, and
// folding it into the key would only let the same forged-header trick
// defeat this limiter too, exactly as it defeats better-auth's. Once
// Railway traffic can be verifiably split (a stable edge CIDR list, or
// private networking segregated away from `/api/auth`), an IP-composed
// *secondary* per-source budget could be layered on top of this one, to
// also blunt one source spraying many different accounts.
//
// Only failed attempts consume budget, and a successful sign-in clears the
// bucket outright. This is deliberate, not incidental: an account-keyed
// limiter that also counted (or blocked) successful attempts would let an
// attacker who never learns the password still deny the real owner access
// indefinitely — send a handful of wrong-password guesses against a known
// email every window, forever, at near-zero cost, and the genuine holder
// of the account is locked out by the same mechanism meant to protect
// them. Counting only failures closes that: the caller in `index.ts`
// always lets a sign-in attempt reach `auth.handler` and inspects the
// real outcome before touching this limiter, so a correct password is
// never rejected on account of someone else's prior wrong guesses,
// however many there were. A distributed password spray against one
// account — many source IPs, one target email — is still bounded: once
// `max` wrong guesses have been recorded inside `windowSeconds`, every
// further failure in that window is turned into a generic 429 instead of
// a distinguishing auth failure, regardless of which IP it came from,
// because the key is the email, never the source.

const MAX_TRACKED_EMAILS = 50_000;

export type SignInAttemptDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly retryAfterSeconds: number };

export type SignInAttemptLimiter = {
  /**
   * Records one failed sign-in attempt against `email`'s budget. Returns
   * `allowed: false` once that account has already exhausted its budget
   * for the current window — the caller should surface that as a 429
   * instead of the underlying auth failure. Never called for an attempt
   * that succeeded.
   */
  recordFailure(email: string): SignInAttemptDecision;
  /**
   * Clears `email`'s bucket entirely. Called after a successful sign-in
   * so a prior run of wrong guesses — an attacker's or the account
   * owner's own mistyping — never carries over to block the next
   * legitimate attempt.
   */
  recordSuccess(email: string): void;
};

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function createSignInAttemptLimiter(
  windowSeconds: number,
  max: number,
): SignInAttemptLimiter {
  const windowMs = windowSeconds * 1000;
  const buckets = new Map<string, { count: number; windowStart: number }>();

  function pruneExpiredAndOverflow(now: number): void {
    for (const [key, bucket] of buckets) {
      if (now - bucket.windowStart >= windowMs) buckets.delete(key);
    }
    if (buckets.size <= MAX_TRACKED_EMAILS) return;
    let overflow = buckets.size - MAX_TRACKED_EMAILS;
    for (const key of buckets.keys()) {
      if (overflow <= 0) break;
      buckets.delete(key);
      overflow -= 1;
    }
  }

  return {
    recordFailure(email: string): SignInAttemptDecision {
      const now = Date.now();
      pruneExpiredAndOverflow(now);
      const key = normalizeEmail(email);
      const bucket = buckets.get(key);
      if (!bucket || now - bucket.windowStart >= windowMs) {
        buckets.set(key, { count: 1, windowStart: now });
        return { allowed: true };
      }
      if (bucket.count >= max) {
        return {
          allowed: false,
          retryAfterSeconds: Math.ceil(
            (bucket.windowStart + windowMs - now) / 1000,
          ),
        };
      }
      bucket.count += 1;
      return { allowed: true };
    },
    recordSuccess(email: string): void {
      buckets.delete(normalizeEmail(email));
    },
  };
}
