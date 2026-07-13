# Design: @Myra in Slack + Slack context ingestion

Status: design (CL-3359). Deliverable is this document and the ticket
breakdown in §6 — not code. Grounded in the current epic tree
(`cl-3305-epic`): the CL-3300 webhook rail
(`apps/hub/src/routes/webhook-trigger-fire.ts`), the ephemeral triage spawn
(`apps/hub/src/services/mailbox-triage.ts`), `principal_mailbox`,
`member_identity`, and the `@workbench/tools-firecrawl` package pattern.

## 0. Shape at a glance

Two sides, one Slack app:

1. **@Myra in Slack** — `app_mention` / DM event → verified public hub endpoint
   → resolve Slack user to a workbench member → one ephemeral Myra session
   (triage machinery generalized) → `chat.postMessage` reply in-thread.
2. **Slack as context** — (a) selected events become `principal_mailbox` rows
   ("Slack pings magically show up in your inbox"), and (b) `slack_search` /
   `slack_read` tools in a new `@workbench/tools-slack` package for bounded
   on-demand history pulls. No bulk ingestion in v1.

## 1. Slack app architecture

**One Slack app ("Myra"), installed per workspace.** App manifest:

- **Event subscriptions** (bot events): `app_mention` (channel mentions),
  `message.im` (DMs to the Myra bot). Request URL: the public hub endpoint
  below.
- **Bot token scopes (minimal v1 set):** `app_mentions:read`, `im:history`,
  `im:read`, `im:write`, `chat:write`, `channels:history`, `channels:read`,
  `users:read`, `users:read.email`. Notes:
  - `users:read.email` is required for identity resolution (Slack user →
    workbench member by email).
  - `channels:history` is only needed for `slack_read`; it grants history of
    channels the bot is _in_ — the bot must be invited to a channel before
    `slack_read` works there. That is a feature: an explicit, visible opt-in per
    channel.
  - **No** `search:read` **in v1** — `search.messages` requires a _user_ token,
    not a bot token. v1 `slack_search` is therefore bot-visible-history only
    (see §4). A user-token search is an explicit open question (§7).
- **Interactivity, slash commands, Socket Mode:** none in v1. Events API over
  HTTPS only, matching the CL-3300 public-endpoint pattern.

**Install flow.** v1: standard "Add to Slack" OAuth v2 flow is _not_ built; the
operator installs the app from the Slack app config page and pastes the **bot
token (`xoxb-…`)** into the Owner → Capabilities page as a tenant credential
(`providerName: "slack"`), exactly like Firecrawl/Exa keys today — this is all
the four tools need and all that ships now. The **signing secret** and
**`team_id`** (needed only by the T2 Events endpoint) are NOT stored via the
generic `secondaryField` (that field is wired to the credential `baseURL`); they
land with T1/T2 under a real `metadata.{teamId,signingSecret}` shape, stored
per-tenant (NOT a hub-wide `requireEnv`, because different tenants connect
different Slack workspaces — see §7 Q1). A guided OAuth install (like Gamma's) is
a fast-follow ticket.

**Storage per the credential model:**

- Credential row: tenant-owned (`principalId: null`), `providerName: "slack"`,
  secret = bot token, `metadata.baseURL = "https://slack.com/api"` — resolved at
  tool/endpoint execution time via `resolveCredentialRequirement`
  (`apps/hub/src/lib/tenant-tools.ts` `providerAvailable` pattern). Never in
  `credentialRequirements` (tool-only provider; would break sidecar launch).
- **What ships in this PR:** the bot token is the only field the four tools
  need. `slack` is added to `CREDENTIAL_PROVIDER_CATALOG` in
  `packages/workbench-shared/src/governance.ts` with `kind: "tool"`,
  `secretLabel: "Bot token"`, `defaultMetadata.baseURL`, and
  `platforms: ["Slack"]` — no `secondaryField`. The generic `secondaryField`
  mechanism stores/reads its value as the credential `baseURL` (it is wired to
  the endpoint override), so it cannot carry a signing secret without silently
  redirecting every Slack API call; adding a signing-secret field is deferred to
  T1/T2 when the Events endpoint actually consumes it.
- **Future (T1/T2), needs its own storage:** `team_id` and the signing secret —
  required for the Events endpoint's team→tenant routing and HMAC verification —
  must be persisted under a real metadata shape (e.g. `metadata.teamId` +
  `metadata.signingSecret`, kept distinct from `baseURL`), NOT via the current
  single-`baseURL` `secondaryField`. Per AGENTS.md the provider credential is
  OWNER-SET on the Owner → Capabilities page, not via a seed env var, so there
  is deliberately no `buildEntries()`/`.env.example` entry.

**Workspace→tenant routing.** Events carry `team_id`. The endpoint maps
`team_id` → tenant by looking up the tenant whose `slack` credential metadata
carries that `teamId`. One workspace maps to exactly one tenant; an event whose
`team_id` matches no tenant is acked and dropped (logged as a count, no
content).

## 2. @Myra flow (mention → ephemeral session → threaded reply)

New public router `apps/hub/src/routes/slack-events.ts`,
`createSlackEventsRouter(deps)`, mounted **on the parent app, outside the v1
session-auth wall**, exactly like the webhook rail (`apps/hub/src/index.ts`:
`app.route("/", createWebhookTriggerFireRouter(...))`). Route: `POST
/slack/events`.

**Endpoint pipeline (per request):**

1. **Raw-body signature verification** (§5) before any parsing. Failure →
   uniform 401 with no detail (the CL-3300 "collapse every rejection" posture;
   here 401 rather than 404 since the URL is static).
2. `url_verification` handshake: echo `challenge` (Slack sends this once when
   the Request URL is saved).
3. **Ack fast.** Return 200 immediately and process the event on an internal
   queue — Slack requires a 2xx within 3 seconds and retries (with
   `x-slack-retry-num`) otherwise. A Myra turn takes far longer than 3s, so the
   mailbox-triage single-flight queue shape (`queue` + `pump()`/`drainQueue()`
   in `mailbox-triage.ts`) is reused verbatim: `enqueue()` is fire-and-forget,
   the handler returns 200, the turn runs behind. Requests bearing
   `x-slack-retry-num` are acked and dropped (we already have the original;
   `event_id` dedupe below is the backstop).
4. **Dedupe** on `event_id` before enqueue (in-memory LRU + the `messageKey`
   unique index for inbox rows, §3).
5. **Rate limiting** via `createRateLimiter` (`apps/hub/src/lib/rate-limit.ts`)
   keyed on `team_id`, generous window (Slack itself retries; the signature
   check is the real gate).

**Per-mention worker (`apps/hub/src/services/slack-mention.ts`, modeled 1:1 on
`mailbox-triage.ts` `runOne`):**

1. **Resolve member.** `users.info` on `event.user` → email → member principal.
   Persist the mapping as a `member_identity` row (`provider: "slack"`, `value:
<slack user id>`, unique on `(tenantId, memberPrincipalId, provider,
value)`) so subsequent mentions skip the email lookup; resolution order is
   member_identity first, email fallback second. Email→member matching goes
   through the same member lookup the auth layer uses (better-auth account
   email), tenant-scoped.
2. **Unresolvable user → polite decline.** `chat.postMessage` in-thread: "I can
   only answer teammates with a Workbench account — ask an admin to invite
   you." No session is spawned; no content is processed further.
3. **Spawn ephemeral Myra.** Reuse the exact triage seams:
   - `resolveMyraDefinition(db, tenantId)`
     (`apps/hub/src/services/myra-threads.ts`)
   - a new `resolveSlackLoadout(autonomy)` persona in `packages/myra` (sibling
     of `resolveMailboxLoadout`, `packages/myra/src/personas/mailbox.ts`) —
     system prompt tells Myra she is answering in Slack: be concise, Slack
     `mrkdwn` not Markdown, no tool-call narration; toolNames include the
     member's normal loadout plus `slack_read`/`slack_search`.
   - the same principal/agentInstance/memberAgentInstance transaction with a new
     `templateKey: "myra-slack"` (parallel to `TRIAGE_TEMPLATE_KEY`), then
     `launchAgentSession(...)` (`apps/hub/src/services/agent-provisioning.ts`).
   - message content = the mention text with the bot-mention token stripped,
     plus lightweight Slack context (channel name, thread parent text if the
     mention is inside a thread — one `conversations.replies` call, bounded).
   - waiter-before-send + `awaitTurn` timeout + `handleTurnFinalized` routing,
     exactly as `mailbox-triage.ts`. Same 180s default timeout.
   - teardown in `finally`: `endSession(address, "slack_mention_done")` +
     `teardownThreadRows` (`myra-threads.ts`).
4. **Reply.** `chat.postMessage` with `channel: event.channel`, `thread_ts:
event.thread_ts ?? event.ts` — always in-thread, never top-level channel
   spam. On turn timeout/failure, post a brief "I couldn't finish that — try
   again in the Workbench" (never a raw error; house rule: hide failures).

**Conversation continuity (v1 stance):** each mention is a fresh session, but
the thread's prior messages are included as context on a follow-up mention in
the same thread (bounded `conversations.replies` pull). True persistent
myra-threads-backed Slack threads (one workbench thread per Slack thread) is a
v2 ticket — the `member_agent_instance.templateKey`/label machinery supports it,
but keeping ephemeral sessions matches the triage model and avoids idle-session
RAM (known sidecar concern).

**DMs to Myra (`message.im`)** run the same worker, minus channel context;
replies go to the DM. Guard against echo loops: ignore events where `bot_id` is
set or `user` is the app's own bot user.

## 3. Slack → inbox (principal_mailbox)

**Which events become inbox rows (v1):**

- **DMs to Myra** — always: the member DMing Myra gets the exchange mirrored to
  their workbench inbox (question + Myra's answer as one row, written after the
  turn), so Slack conversations are visible/triageable in the workbench.
- **Channel mentions of the member** — the "Slack pings magically show up in
  your inbox" ask. v1 mechanism: when any subscribed event's text contains
  `<@U…>` tokens, resolve each mentioned Slack user via `member_identity`
  (`provider: "slack"`); for each resolved member, write an inbox row.
  Constraint: with only `app_mention` + `message.im` subscribed, we only _see_
  messages that also mention the bot or are DMs — capturing arbitrary member
  mentions requires subscribing to `message.channels` (bot must be in the
  channel) which is a firehose. **v1 cut: member-mention rows only for messages
  the bot already receives; full member-ping capture is a v1.1 ticket** with the
  `message.channels` subscription gated per-channel by bot membership (see §7
  Q3).
- Explicitly **not** inbox items: every channel message, reactions, joins,
  edits.

**Write path:** `writeMailboxMessage(db, { tenantId, principalId, address,
fromAddress: "slack@<tenantDomain>", subject: "Slack: #<channel> — <sender
display name>", body, messageKey: "slack:<event_id>", inReplyTo? })`
(`apps/hub/src/lib/mailbox-write.ts`; `onConflictDoNothing` on the partial
unique index `principal_mailbox_message_key_uniq` — keyed `(tenantId,
principalId, messageKey)`, already per-principal — gives free idempotency across
Slack retries).

**Triage interaction:** rows written with `fromAddress: slack@…` come from a hub
rail. `mailbox-triage.ts` skips senders in `SYSTEM_SENDER_LOCAL_PARTS` (`hub`,
`myra`); decision needed on whether `slack` joins that set. **Recommendation: do
NOT suppress** — a Slack ping is exactly the external signal triage exists for;
Myra triaging your Slack mentions is the magic. But the DM-mirror rows (which
already contain Myra's answer) should carry a sender that _is_ suppressed, or
they'd re-triage her own output — mirror rows use `fromAddress:
myra@<tenantDomain>`, ping rows use `slack@<tenantDomain>`.

## 4. Context tools: `@workbench/tools-slack`

New package `packages/tools-slack`, modeled on `@workbench/tools-firecrawl`
(definitions in package; hub resolves the credential; `ToolDefinition` from
`@intx/types/runtime` + `createSlackTools(config)` factory returning
`AgentTool`s; arktype `SlackToolsConfig = { botToken: "string", teamId:
"string" }` with a `resolveConfig` that throws on missing token).

**Tools (all read-only except the explicit post):**

- `slack_list_channels` — `conversations.list` (public channels the workspace
  exposes, cached), returns `{ channels: [{ id, name, isMember }] }`. Lets a
  weak model discover a channel id before `slack_get_channel_history`.
- `slack_get_channel_history` (aka `slack_read`) — `conversations.history` /
  `conversations.replies` for a named channel or thread. Flat convenience params
  (kimi-safe, per CL-2319): `channel` (name or id), `thread_ts?`, `limit`
  (default 30, max 100), `oldest?`/`latest?` (Slack `ts`, e.g.
  "1234567890.123456" — not ISO). Resolves channel name → id
  via `conversations.list` (cached). Returns `{ channel, messages: [{ ts, user,
userName, text, threadTs? }] }`. Errors like `not_in_channel` surface as an
  actionable message ("invite @Myra to #chan").
- `slack_post_message` — `chat.postMessage` (write; `sideEffect: true`).
  Params: `channel`, `text`, `thread_ts?`. The one write tool; excluded from any
  read-only loadout and gated by its own grant.
- `slack_search` — v1 is **not** Slack's `search.messages` (user-token-only).
  Instead: bounded scan over the channels the bot is a member of
  (`users.conversations`) — pull last N messages per channel,
  substring/keyword filter hub-side, hard caps (≤10 channels × ≤100 messages,
  ≤15s). Honest and bounded; the tool description says exactly what it can see.
  If true workspace search is wanted, that's the user-token question (§7 Q2).

**Wiring checklist (as shipped):**

1. **Credential is OWNER-SET, not seeded.** Per an explicit owner directive,
   provider credentials are entered on the Owner → Capabilities page, not via a
   seed env var — so there is deliberately **no** `buildEntries()` entry in
   `apps/hub/bin/seed-credentials.ts` and **no** `.env.example` var for `slack`
   (the AGENTS.md seed step is intentionally skipped).
2. `CREDENTIAL_PROVIDER_CATALOG` entry (`kind: "tool"`, `secretLabel: "Bot
token"`, `defaultMetadata.baseURL`, `platforms: ["Slack"]`). **No
   `secondaryField`:** the generic `secondaryField` is stored/read as the
   credential `baseURL` (endpoint override), so it cannot carry a signing secret
   without silently redirecting every Slack API call. A properly-stored signing
   secret arrives with the Events endpoint (T2) that consumes it.
3. `slack` flows into Myra's provider set via `PACKAGE_PROVIDERS` + the
   dynamic-tools catalog (never `credentialRequirements` — tool-only provider).
4. Tool package added to hub tool registry `KNOWN_TOOLS` / `PACKAGE_TOOLS` /
   `PACKAGE_PROVIDERS` / dynamic-tools catalog (CL-2643 landmine), `TOOL_PACKAGES`
   in `build-tool-packages.ts`, Dockerfile manifest COPY (all three images) +
   full-source COPY (hub only).
5. Grants: `<factoryId>:slack_*` per the CL-2145 prefixing rule; `slack_post_message`
   is `sideEffect: "write"` → auto-added to `APPROVAL_GATED_TOOL_NAMES`
   (`slack__post_message`).

**Client abstraction (T3 prerequisite, not now).** The four tools share a small
`slackCall(config, method, params, signal)` helper (form-encoded POST, arktype
envelope parse, 429/Retry-After backoff, TTL'd channel-name→id cache). At four
tools this is the right size; **do NOT refactor it into a typed Slack client
yet** (premature). When the T3/T4 work (identity resolution + mention worker)
adds `users.info`, `conversations.replies` context pulls, and `chat.postMessage`
from the events path, promote `slackCall` to a typed client (per-method
request/response schemas, shared rate-limit + cache) as a **prerequisite of
T3** — call this out so it is planned, not discovered.

## 5. Security

- **Signature verification on the raw body, with per-tenant secret selection
  (the specified T2 ordering).** A per-tenant signing secret and "verify before
  parsing" are in tension: you must know _which_ tenant's secret to use before
  you can verify, and the tenant is identified by `team_id` _inside_ the body.
  Resolve it with this exact ordering (never trust the body before step 5):
  1. Read the raw bytes once via `c.req.text()` (before any JSON parse); apply
     the 32KB body ceiling (`MAX_BODY_BYTES` discipline) first.
  2. Reject immediately if `X-Slack-Request-Timestamp` drifts >5 minutes from
     server time (replay guard) — cheap, no body trust needed.
  3. Extract `team_id` from the raw bytes via a **minimal, bounded field scan**
     — a single regex for the `"team_id":"T…"` token (Slack sends a flat
     top-level field), NOT a full `JSON.parse` of untrusted input. If absent or
     malformed → uniform reject.
  4. Look up the tenant whose `slack` credential metadata carries that `team_id`
     and load its signing secret. No match → uniform reject (no enumeration).
  5. Compute `v0:<timestamp>:<raw body>` HMAC-SHA256 with that secret and
     `crypto.timingSafeEqual` it against `X-Slack-Signature` (`v0=<hex>`) over
     the **raw bytes** (not a re-serialized object). Only after this passes is
     the body `JSON.parse`d and processed.

  The `team_id` scan in step 3 is untrusted routing metadata used _only_ to pick
  a key; the HMAC in step 5 is what authenticates it, so a spoofed `team_id`
  simply selects a secret the attacker cannot forge a signature for. This
  resolves the §7 Q1 "one shared app, one signing secret per workspace" model
  against the "verify first" rule. (`signingSecret` + `team_id` must be persisted
  under a real metadata shape — see §1 future-work note — not the shipped
  single-`baseURL` field.)

- **Uniform rejection:** invalid signature, stale timestamp, unknown team_id →
  same terse response; no enumeration surface (the CL-3300 posture).
- **Replay/dedupe:** timestamp window + `event_id` dedupe + `messageKey` unique
  index. Retried deliveries (`x-slack-retry-num`) acked and dropped.
- **Minimal scopes:** the §1 list only; no `search:read`, no `channels:join`, no
  write scopes beyond `chat:write`/`im:write`. Bot must be invited to a channel
  to read it — visible opt-in.
- **No message content in logs:** log event type, team_id, channel id, event_id,
  member principal id, timing, outcomes — never `text`, never user emails. Same
  rule as mailbox rails.
- **Token handling:** bot token lives only in the credential store, resolved
  per-execution; never in env dumps, never forwarded to the sidecar as env.
- **Decline path leaks nothing:** unresolved users get the canned decline; their
  message content is not processed, stored, or logged.
- **Tenant isolation:** team_id→tenant mapping is exact; all downstream lookups
  tenant-scoped (member_identity unique key already includes tenantId).

## 6. v1 cut + ticket breakdown

**Scoping decision (recorded, not a detail) — one workspace per tenant.** v1
stores exactly **one `slack` credential (bot token) per tenant**, mapping one
Slack workspace to one tenant. The "one shared Corbits app, multi-workspace-
installable" model in §7 Q1 is **deferred and is a known architectural fork, not
a config toggle**: it REQUIRES a **credential-schema change** — the credential
must gain a first-class `workspace`/`team_id` field (and support multiple
credentials per tenant keyed by workspace) so the events endpoint can resolve
`team_id → (tenant, bot token, signing secret)` when several workspaces share
one app. Until that schema change lands, `team_id`/`signingSecret` live in
credential metadata (see §1 future-work) and each tenant is single-workspace.
Choosing multi-workspace later is a deliberate migration, planned as its own
project — not retrofittable silently.

**In v1:** one Slack app; operator paste-token install; `app_mention` +
`message.im`; signature-verified public endpoint; ephemeral-Myra reply
in-thread; polite decline; DM-mirror + bot-visible-ping inbox rows with
`slack:<event_id>` dedupe; `tools-slack` with `slack_list_channels`,
`slack_get_channel_history`, `slack_post_message`, and bounded `slack_search`;
full seed/catalog/governance wiring.

**Out of v1:** OAuth install flow, Socket Mode, slash commands, persistent
Slack↔workbench threads, `message.channels` firehose for full member-ping
capture, user-token workspace search, interactive blocks/buttons,
multi-workspace-per-tenant.

**Proposed tickets (ordered; each independently shippable):**

1. **T1 — Slack credential + catalog wiring.** `slack` provider: OWNER-SET
   catalog entry (bot-token secret; no seed/.env). Adds the real
   `metadata.teamId` + `metadata.signingSecret` shape (credential-schema change)
   the events endpoint needs. Tests. (S) **— catalog entry shipped under CL-2287;
   the metadata-shape + signing-secret storage is the remaining T1 scope.**
2. **T2 — Slack events public endpoint.** `createSlackEventsRouter`: raw-body +
   `team_id`-scan → per-tenant signing-secret selection → HMAC verify (the §5
   ordering) + replay guard + url_verification + fast-ack queue + event_id
   dedupe + rate limit + team→tenant resolution. Mounted outside the auth wall.
   (M)
3. **T3 — Slack identity resolution.** `member_identity provider:"slack"`
   read/write path, `users.info` email fallback, decline message. **Promote
   `slackCall` → a typed Slack client (per-method schemas, shared rate-limit +
   channel cache) as a prerequisite** (see §4). (S)
4. **T4 — @Myra mention worker.** `slack-mention.ts` service: ephemeral spawn
   via triage seams, `resolveSlackLoadout` persona in `packages/myra`, threaded
   `chat.postMessage` reply, timeout fallback message. Depends T1–T3. (L)
5. **T5 — Slack→inbox rows.** DM mirror + bot-visible member-ping rows,
   `messageKey` dedupe, triage-interaction senders. Depends T2, T3. (M)
6. **T6 — `@workbench/tools-slack`.** `slack_list_channels`,
   `slack_get_channel_history`, `slack_post_message`, bounded `slack_search`;
   registry/KNOWN_TOOLS/Dockerfile/publish wiring, grants, persona inclusion.
   Depends T1. (M) **— built alongside this design under CL-2287.**
7. **T7 (v1.1) — Guided OAuth install** (Gamma-style) replacing paste-token.
   (M)
8. **T8 (v1.1) — Full member-ping capture** via per-channel `message.channels`.
   (M)

## 7. Open questions for Sawyer (with recommendations)

1. **One Corbits Slack app vs per-tenant apps?** _Recommend: one Corbits-owned
   app, multi-workspace-installable_, with per-tenant bot token + team_id in the
   credential store. One app = one signing secret; since the credential model
   stores it per-tenant anyway, the endpoint verifies against the tenant
   resolved from `team_id` (two-pass: parse team_id from body, then verify —
   safe because verification still happens before any processing). Per-tenant
   apps only make sense if a client demands their own branding/app review; the
   design supports it for free since everything is keyed per-tenant.
2. **True workspace search (user token)?** `search.messages` needs a user token
   via per-user OAuth (`search:read` user scope). _Recommend: defer_ — the
   bounded bot-visible `slack_search` covers "what did the team say about X in
   our channels"; user-token OAuth is a per-member consent flow worth its own
   project if demanded.
3. **How magical should inbox pings be?** Full member-ping capture needs
   `message.channels` (every message in every bot-joined channel hits our
   endpoint). _Recommend: ship v1 with bot-visible pings only_, then T8 gated
   per-channel — the invite-the-bot gesture doubles as the opt-in.
4. **Should Slack ping rows trigger mailbox triage?** _Recommend: yes_ (don't
   add `slack` to `SYSTEM_SENDER_LOCAL_PARTS`); Myra triaging your Slack
   mentions is the payoff. DM mirrors use `myra@` sender so they stay
   suppressed.
5. **Non-member mentions in channels Myra is in:** decline publicly in-thread
   (recommended, it's honest) vs stay silent? _Recommend: decline once per user
   per channel per day_ to avoid spam loops.
6. **Persistent Slack threads ↔ myra-threads?** _Recommend: defer_;
   ephemeral-with-thread-context gets 90% of the value without idle-session RAM
   cost.
