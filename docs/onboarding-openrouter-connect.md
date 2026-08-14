# OpenRouter connect: one-click credentials in onboarding

The onboarding wizard's credential step offers two paths: paste a
provider API key, or — the path the card at the top of the step
suggests first — connect OpenRouter with one click. The connect path is
OpenRouter's registration-free OAuth PKCE flow
(openrouter.ai/docs, "OAuth PKCE"): no client id or secret to
provision, and the exchange at the end returns a **durable user-scoped
API key**, not an expiring access token. That property is why the flow
fits the platform's credential model with no new machinery — the minted
key stores as an ordinary `api_key` credential through the hub's native
credential route, embeds in workflow deployments the same way a pasted
key does, and needs no refresh loop.

## The round trip

All server pieces live in `@workbench/onboarding` (mounted by the hub
at `/api/onboarding`); the wizard only navigates.

1. **`GET /oauth/openrouter/start`** — requires a signed-in session.
   Generates a fresh PKCE verifier and its S256 challenge
   (`openrouter-connect.ts`), seals the verifier into a single-use
   state with a ten-minute TTL (matching OpenRouter's own
   authorization-code expiry) — encrypted through the same
   `CredentialCipher` seam `CREDENTIAL_ENCRYPTION_KEY` backs everywhere
   else a secret is encrypted at rest, so the verifier never leaves the
   server in the clear — sets that state in an HttpOnly
   `SameSite=Lax` cookie, and 302s the browser to
   `https://openrouter.ai/auth?callback_url=...&code_challenge=...&code_challenge_method=S256`.
   The callback URL's **origin comes from the hub's configured
   `BASE_URL`** (never the request's host header) and its **path from
   the request** (so the mount prefix is not guessed at) — this is what
   makes the same code correct for `http://localhost:3000` dev and a
   deployed hub behind a proxy.
2. **User approves on OpenRouter.** Localhost callback URLs are allowed
   by OpenRouter for development; a public callback URL is what names
   the app in the user's key list.
3. **`GET /oauth/openrouter/callback?code=...`** — reads the state from
   the cookie and consumes it (single use: expired, replayed, unknown,
   or another user's state all fail the same way, before any network
   call), then POSTs `{ code, code_verifier, code_challenge_method }`
   to `https://openrouter.ai/api/v1/auth/keys`. The response is parsed
   with arktype at the trust boundary; a 200 without a key is a
   failure, never a crash or a fabricated success.
4. **Only the fast half runs inline.** The minted key goes through
   `testAndPersistCredential` with provider `openrouter` — the same free
   `testProviderCredential` probe (`GET /api/v1/key`, the auth-gated
   key-status endpoint; OpenRouter's `/api/v1/models` is public and
   proves nothing) is the only proof the key gets, and a rejected probe
   is the sole way this ends in `key_rejected`. Once it passes, the
   curated OpenRouter seed from `CATALOG_SEEDS` (`catalog-seed-data.ts`:
   a small hand-picked model set on one provider row with plugin
   `openai-compatible`) is planted and the key is stored through the
   hub's native `POST /api/tenants/:id/credentials` — the onboarding
   package never stores a secret itself. **Deploying the default
   routines against that key never happens here.** That used to run
   inline too (`seedTenant`, several seconds of deploy calls per
   workflow), which made this request the slow, non-idempotent one: a
   browser that fired the callback twice with the same code burned the
   single-use state on its first arrival and saw `state_expired` on the
   second, for a connection that had actually succeeded. The callback
   now returns as soon as the key is proven and stored — see
   `complete-credential.ts`'s module comment for the fast/slow split,
   and `ensureSeeded` for the deploy step's new home.
5. **The plaintext key rides forward server-side, never to the
   browser.** Credential secrets are write-only through the hub's own
   API, so nothing can re-fetch the key once this request ends. It is
   instead sealed (AEAD, the same `CredentialCipher` the state above
   uses) into a row in `@workbench/onboarding`'s own `onboarding`
   Postgres schema (`pending-seed.ts`, `createDrizzlePendingSeedStore`)
   keyed by `(userId, tenantId)`, with a ten-minute TTL — long enough
   for the wizard's own follow-up call. The browser gets nothing from
   this step: no cookie, no ciphertext, not even a token — its ordinary
   session cookie is what scopes `/complete-setup`'s read to exactly
   this row. (Before CL-6031 this rode forward as an HttpOnly
   `workbench_pending_seed` cookie; moved server-side because the
   browser had no business custodying a sealed copy of the key even
   though it could never read it. See `pending-seed.ts`'s module
   comment for the full rationale, including the future
   `InferenceSource` credential-by-reference primitive that would
   remove this store entirely.)
6. **Back to the wizard.** Every ending 302s to
   `/onboarding?connect=openrouter&...`: `outcome=connected` with the
   bench slug (no routine list yet — that comes from step 7), or
   `outcome=error` with a short machine code (`state_expired`,
   `exchange_failed`, `key_rejected`, `no_bench`, `setup_failed`,
   `signed_out`, `rate_limited`). Before reporting `state_expired` for a
   single-use state that came back already consumed, the callback checks
   whether this exact session's user already has an active OpenRouter
   credential created within the state's own TTL — the twin of a
   duplicate callback that already succeeded on its first arrival. Only
   a genuinely expired or wrong-session state still errors. The wizard
   parses these as untrusted input, maps codes to copy, and strips the
   parameters from the URL. The key itself never appears in a URL, a
   redirect, or a log line.
7. **The wizard finishes the job.** Landing on `outcome=connected`, the
   wizard shows a brief "setting up your workbench" state and calls
   `POST /api/onboarding/complete-setup`. That route reads the pending
   row for the caller's own `(userId, tenantId)`, runs `ensureSeeded`
   (`seedTenant` with
   `confirmDeployments: false`, same as before), and answers `seeded`
   with the deployed routine names once done. It answers `unseeded`
   (never an error) if there is nothing to seed with yet, and two
   overlapping calls never double-deploy — every step `ensureSeeded`
   drives is itself ensure-then-create (a 409 falls back to a list),
   the same tolerance `seedTenant` has always had.

## CSRF model

OpenRouter's flow has no OAuth `state` parameter — nothing we send to
`openrouter.ai/auth` is echoed back on the callback. The binding is
therefore deliberately two-sided, and spec-valid per RFC 7636:

- **Session binding is ours.** The single-use state travels only in our
  own HttpOnly `SameSite=Lax` cookie, and consuming it requires the
  same signed-in user who started the flow — a callback presented under
  a different session (login CSRF, replayed cookie) fails before any
  network call, and the exchange never runs.
- **Code binding is OpenRouter's.** The authorization code is bound to
  the S256 challenge presented at `/auth`; the exchange only succeeds
  with the matching verifier, which never left this process. An
  attacker-injected foreign code cannot be redeemed with our verifier.

This is a real trust dependency: the second half rests on OpenRouter
enforcing the challenge/verifier check server-side, as its docs state.
There is no way to strengthen it client-side without a `state`
round-trip OpenRouter does not offer.

## Why OpenRouter, and why not the others

OpenRouter's PKCE flow is explicitly designed for third-party apps —
no client registration, S256, key output. Anthropic and Google both
prohibit third parties from riding their first-party OAuth clients
(their cards stay key-paste), and OpenAI's sign-in is partner-gated.
The one-click card is therefore OpenRouter alone today.

## Dev notes

- In `vite dev`, the start navigation goes through the `/api` proxy to
  the hub; OpenRouter then calls back on the hub origin (`BASE_URL`,
  usually `http://localhost:3000`), so the wizard resumes on the hub
  origin rather than the vite one. Cookies are host-scoped (ports are
  ignored), so both the session and the state cookie survive the hop.
- The pending-connect state is a signed/encrypted token, not a
  server-side lookup, so it survives a hub restart between `/start` and
  `/callback` (a dev watch reload, a deploy) as long as
  `CREDENTIAL_ENCRYPTION_KEY` is stable — the callback no longer has to
  land on the exact process that issued it. See `pkce.ts`'s
  `createConnectStateStore`. (The per-user rate limiters are still
  plain in-process maps, so a restart does reset those — a client can
  immediately retry a start it otherwise would have been briefly
  rate-limited on. Low-stakes: worst case is one extra pending state.)
