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
(`providerName: "slack"`), exactly like Firecrawl/Exa keys today. The **signing
secret** is also stored per-tenant as a second credential field
(`secondaryField` in the catalog entry) — NOT a hub-wide `requireEnv`, because
different tenants will connect different Slack workspaces (see §7 Q1). A guided
OAuth install (like Gamma's) is a fast-follow ticket.

**Storage per the credential model:**

- Credential row: tenant-owned (`principalId: null`), `providerName: "slack"`,
  secret = bot token, metadata = `{ teamId, signingSecret? }` — resolved at
  tool/endpoint execution time via `resolveCredentialRequirement`
  (`apps/hub/src/lib/tenant-tools.ts` `providerAvailable` pattern). Never in
  `credentialRequirements` (tool-only provider; would break sidecar launch).
- `slack` added to `buildEntries()` in `apps/hub/bin/seed-credentials.ts` (env
  `SLACK_BOT_TOKEN`, metadata carries `SLACK_SIGNING_SECRET` + `SLACK_TEAM_ID`)
  and to `CREDENTIAL_PROVIDER_CATALOG` in
  `packages/workbench-shared/src/governance.ts` (`kind: "tool"`, `secretLabel:
"Bot token"`, `secondaryField` = signing secret, `platforms: ["slack"]`).

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
  (default 30, max 100), `oldest?`/`latest?` (ISO). Resolves channel name → id
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

**Wiring checklist (per AGENTS.md):**

1. `buildEntries()` entry in `apps/hub/bin/seed-credentials.ts` gated on
   `SLACK_BOT_TOKEN`, + `.env.example` vars, + the appears/disappears test.
2. `CREDENTIAL_PROVIDER_CATALOG` entry (`kind: "tool"`, `secondaryField` for
   signing secret) — the `surfaces every seeded tool credential` test enforces
   this.
3. `slack` added to Myra's deploy-descriptor `credentialProviderNames`
   (`packages/agents/...` — NEVER `credentialRequirements`).
4. Tool package added to hub tool registry + `KNOWN_TOOLS` / `PACKAGE_TOOLS` /
   `PACKAGE_PROVIDERS` / dynamic-tools catalog (CL-2643 landmine), Dockerfile
   manifest COPY lines, publish via build-tool-packages/publish-tool-packages.
5. Grants: `<factoryId>:slack_*` per the CL-2145 prefixing rule; included in the
   Slack persona loadout and optionally the default Myra loadout.

## 5. Security

- **Signature verification first, on the raw body:**
  `v0:<X-Slack-Request-Timestamp>:<raw body>` HMAC-SHA256 with the signing
  secret, compared with `crypto.timingSafeEqual` against `X-Slack-Signature`
  (`v0=<hex>`). Reject if timestamp drifts >5 minutes from server time (replay
  guard). Read `c.req.text()` before JSON parse (the webhook rail already does
  raw-body-first). Body size ceiling (32KB, same constant discipline as
  `MAX_BODY_BYTES`).
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

1. **T1 — Slack credential + catalog wiring.** `slack` provider: seed entry,
   `.env.example`, catalog entry with signing-secret secondaryField, tests. (S)
2. **T2 — Slack events public endpoint.** `createSlackEventsRouter`: signature
   verify + replay guard + url_verification + fast-ack queue + event_id dedupe +
   rate limit + team→tenant resolution. Mounted outside the auth wall. (M)
3. **T3 — Slack identity resolution.** `member_identity provider:"slack"`
   read/write path, `users.info` email fallback, decline message. (S)
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
