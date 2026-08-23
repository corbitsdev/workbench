# In-room connect cards

The 0-1 flow (CL-6393): when a request needs a service the workbench
hasn't connected, the agent's reply stays helpful on its own and a
connect card appears in the room. Connecting flips the card and resumes
the agent — no settings page round-trip, no "report back when done".

## The pieces

- **Block** — `connect-service` (`packages/chat/src/blocks.ts`,
  `ConnectServiceBlockData`). Carries agent-authored framing only:
  `connectorId`, `displayName`, and a consumer-language `reason`
  ("Connect Gmail so I can send this for you."). It never carries an
  auth mode or a connected verdict — those would let an agent spoof
  live state next to a live button.
- **Card** — `ConnectServiceBlockView` /
  `ConnectServiceBlockContainer` (`packages/chat-ui/src/blocks/`).
  The host-supplied `ConnectServiceActions` port resolves the live
  state and the connect affordance: one click for hosted OAuth and
  keyless MCP presets, an inline key-paste for api-key connectors.
  `apps/web/src/connect-service-actions.ts` is the workbench binding.
- **Emission** — `request_connection`
  (`packages/connections-tools/src/tool.ts`) posts the block into the
  caller's own room through the same `participants/messages` route
  `ask_user` uses, and tells the model to keep helping in the meantime
  (draft now, finish once connected). A run with no room of its own
  falls back to a plain deep link.
- **Pending ledger** — posting the block registers the connector under
  the room settings key `connections/pending`
  (`packages/chat/src/connect-pending.ts`, applied by
  `workflow-participant-routes.ts`), so a later connect can find every
  room that is waiting.
- **Settling** — every connect surface in `@workbench/connections`
  (OAuth callback, pasted key, MCP OAuth, keyless MCP preset) fires the
  optional `onConnected` hook (`src/connected-hook.ts`) once the
  credential is durably stored. The hub wires it to
  `settleConnectedService` (`packages/chat`): the pending entry clears,
  `chat.settings` publishes so the open card flips, and the host agent
  is woken via `dispatchTurn` / `sendMail` — never by posting a timeline
  row as the connecting person.

## GitHub (Code review)

GitHub for Code review is **PAT-first** today (`connect-github` block +
`packages/chat-ui` card, CL-6345): Connect opens a guided personal-access-
token paste (create a token with the `repo` scope, paste it, store
encrypted). After Connect succeeds, the same card flips in place to pick
repositories — Code review needs a repo pick before reviewers are
watching. Reviewers then introduce themselves as left-aligned messages.

A GitHub App / hosted OAuth Connect as the welcome mat is CL-6343, out of
scope for the shipped card — do not document OAuth-first GitHub connect
as current. A stale Connect after success, or an agent 401 after GitHub
already connected, is still a broken first minute (PRODUCT.md).

The generic `connect-service` card (above) still offers one-click hosted
OAuth for connectors that are actually OAuth-only (e.g. Gmail); GitHub's
own template card does not ride that path.

## Gmail

`gmail` is a pure hosted-OAuth connector
(`packages/connections/src/gmail-connect.ts` + the registry entry):
Google's code flow with PKCE, the `gmail.modify` scope, and
`access_type=offline` so the exchange captures a refresh token — stored
as the credential row's `refreshSecret` next to the one-hour access
token. Configure `GMAIL_CLIENT_ID` / `GMAIL_CLIENT_SECRET` (a separate
OAuth client from the sign-in `GOOGLE_CLIENT_ID`); see `.env.example`
for the exact-match redirect-URI requirement and the Google app
verification lead time. Unconfigured deployments render the card as
not-configured — never a dead key-paste form. Automatic refresh of
registry-connector tokens and Gmail read/draft/send tools are not built
yet; the connector stores proven material for both.
