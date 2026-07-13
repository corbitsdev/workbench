# @workbench/tools-slack

Slack Web API tool implementation. Registered in the hub's tool registry.

## Read tools

- `slack_list_channels` — list the workspace's public channels (`conversations.list`); each row carries `isMember` so the model knows whether `slack_get_channel_history` will work there
- `slack_get_channel_history` — recent messages in a channel or thread (`conversations.history` / `conversations.replies`); accepts a channel id or name (resolved via `conversations.list`), a `limit` (default 30, max 100), and `oldest`/`latest` bounds. `not_in_channel` surfaces as an actionable message ("invite the bot to the channel")
- `slack_search` — bounded keyword scan over the channels the bot is a member of (`users.conversations` → `conversations.history`), hub-side substring filter, hard-capped (≤10 channels × ≤100 messages). NOT Slack's `search.messages` (that needs a user token); the description says exactly what it can see

## Write tools

- `slack_post_message` — post a message to a channel or thread (`chat.postMessage`). Approval-gated (`sideEffect: "write"`): a call opens the human ReviewGate before it runs. Listed as `slack__post_message` in `APPROVAL_GATED_TOOL_NAMES` in `@workbench/agents`, enforced by the `approval-gated-tools.test.ts` drift guard.

## Wiring

- Credential (`slack` provider) is resolved by Interchange at tool execution time — not at agent launch. The secret is the bot token (`xoxb-…`); `metadata.baseURL` defaults to `https://slack.com/api`. `slack` is a tool-only provider — it goes in Myra's `credentialProviderNames`, NEVER `credentialRequirements`.
- The bot must be invited to a channel before `slack_get_channel_history` / `slack_search` can read it — an explicit, visible per-channel opt-in.
- The tool grants `tool:<name>/invoke` are synthesized at session launch from the agent's capabilities list; do not add them to the DB.
- A new write tool must be added to `APPROVAL_GATED_TOOL_NAMES` in `@workbench/agents` or the drift guard fails.

## Reliability

- All calls go through `slackCall`, which honors HTTP 429 `Retry-After` with bounded retries (`RATE_LIMIT_MAX_ATTEMPTS`, per-wait ceiling), an abortable backoff (respects the tool `AbortSignal`), and fails loudly once retries are exhausted.
- Channel name→id resolution is memoized in a bounded, TTL'd per-workspace cache so a name-based call does not re-paginate `conversations.list` every time.
- `slack_search` logs (structured, `@intx/log` `["tools","slack"]`, no message content) when it skips a channel whose history response is malformed — failures are not silently indistinguishable from "no matches".

## Testing

Follow root [AGENTS.md](../../AGENTS.md) testing standards. Tests mock `fetch` at
the Slack Web API boundary and exercise the real tool handlers.
