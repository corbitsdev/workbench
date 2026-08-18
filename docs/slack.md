# Slack

Workbench can be mentioned in Slack. A Slack workbench gets bound, on first
contact, to one workbench workbench with one agent already in it; every
mention or thread message in that Slack workbench is posted into the bound
workbench workbench exactly the way a person's message from the web app
would be, and the agent's reply is relayed back to Slack.

This is Phase 1 (CL-5288): one Slack workspace maps to one bench, and one
Slack workbench maps to one workbench workbench with one agent. There is no
per-thread routing, no slash commands, and no interactive buttons yet.

## What "workbench binding" means

The first time someone mentions the bot (or messages a thread it is
watching) in a given Slack workbench, workbench:

1. Provisions an Interchange principal for that person, if one doesn't
   already exist for their Slack email (see "Identity" below).
2. Creates a new workbench workbench, titled after the Slack workbench's name,
   with the agent named by `SLACK_DEFAULT_AGENT_DEFINITION_ID` already
   invited into it.
3. Records the binding: this Slack workbench now always resolves to that
   same workbench workbench.

Every later message in that Slack workbench reuses the same binding — no new
workbench is created. The binding is scoped per bench (see `SLACK_WORKBENCH_TENANT_SLUG`
below), so two Slack workspaces configured against two different benches
can never see each other's bindings even if their Slack workbench ids
happened to collide.

## Identity

Being in the Slack workbench is the authorization: the Slack app is only
installed into workbenches a workspace admin chose, so anyone who can reach
the bot there was already let in. Workbench resolves the sender's Slack
profile email to an existing Interchange account when one exists, and
auto-provisions one on first contact otherwise (a real account with no
password — if that person later signs into workbench directly with the
same email, they arrive with this history already attached). Slack bots
are never resolved to a principal, and Slack guest/shared-workbench accounts
are declined with an explanation posted back to the thread.

## Expected behavior

- Mention the bot, or reply in a thread it has joined, and it answers in
  that thread — a "thinking…" placeholder appears immediately and is
  replaced with the real answer once the agent responds, or quietly
  removed if nothing comes back within the wait window.
- Every reply the agent posts into the bound workbench workbench through its
  normal delivery path is also visible in the web app for that workbench —
  Slack is one more way in, not a separate conversation.
- If nothing lands within the wait window, the placeholder is retracted;
  the agent's reply (once it does complete) will still be visible in the
  web app.

## Operator setup

1. **Create the Slack app from the manifest.** `@corbits/slack-tag`
   exports `renderSlackAppManifest(origin)`, which fills in your
   deployment's public origin (e.g. `https://bench.example.com`) against a
   manifest declaring the bot scopes and event subscriptions workbench
   needs:

   ```ts
   import { renderSlackAppManifest } from "@corbits/slack-tag/manifest";
   console.log(renderSlackAppManifest("https://bench.example.com"));
   ```

   Paste the rendered YAML into
   [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** →
   **From an app manifest**. A local dev origin and a deployed origin must
   be two separate Slack apps — a manifest names exactly one request URL.

2. **Install the app** to your workspace, then copy its **Bot User OAuth
   Token** (starts `xoxb-`) from _OAuth & Permissions_, and its **Signing
   Secret** from _Basic Information_.

3. **Set the environment variables** (see `.env.example`):

   - `SLACK_BOT_TOKEN` — the bot token from step 2.
   - `SLACK_SIGNING_SECRET` — the signing secret from step 2.
   - `SLACK_WORKBENCH_TENANT_SLUG` — the slug of the bench this Slack
     workspace's messages land in.
   - `SLACK_DEFAULT_AGENT_DEFINITION_ID` — the id of an already-deployed
     agent definition in that bench; this is who answers.

   Leaving `SLACK_BOT_TOKEN`/`SLACK_SIGNING_SECRET` unset is a valid
   configuration — the hub runs with no Slack app mounted. Setting that
   pair without also setting the tenant slug and definition id is a boot
   error: there is no honest default for which bench or which agent a
   Slack message should reach.

4. **Invite the bot** into whichever Slack workbenches should talk to
   workbench, and mention it.

## Phase 1 limitations

- **Thread state is in-memory and does not survive a hub restart.**
  `corbits-tag/slack`'s own bookkeeping — in-flight thinking-indicator
  placeholders, message dedup, and which threads the bot is subscribed to
  — is held in a `createMemoryState()` adapter (see
  `apps/hub/src/slack-tag-mount.ts` and `packages/slack-tag/src/thread-state.ts`),
  not a durable one. A hub restart mid-flight drops any pending
  thinking-indicator placeholders (they are simply never retracted or
  replaced) and forgets ambient-thread subscriptions, so a Slack thread the
  bot had joined stops receiving unmentioned follow-ups until it is
  @-mentioned again. `SlackWorkbenchBindingStore` (the Slack-workbench-to-
  workbench-workbench binding itself) is unaffected — that is a separate,
  durably stored record. A Postgres-backed `StateAdapter` for this thread
  state is Phase 2 follow-up work, not yet built.
- **Workbench ingress only — no DMs.** The Slack app requests no
  `im:history`/`mpim:history` scopes and subscribes to no `message.im`/
  `message.mpim` events, since the package's whole authorization model
  rests on the bench owner having chosen to install the app into a
  workbench — a DM bypasses that gate entirely. `dispatchWorkbenchSlackEvent`
  also declines any DM-sourced event defensively, in case one ever arrives.

## Where this lives

- `packages/slack-tag` — the mount composition: principal resolution,
  workbench binding, and the dispatch flow. Nearly all of the behavior
  described above lives here.
- `apps/hub/src/slack-tag-mount.ts` — the thin, env-gated glue that wires
  this hub's already-running `@corbits/chat` platform into
  `packages/slack-tag`'s injected dependencies.
- [corbits-tag](https://github.com/corbitsdev/corbits-tag) — the
  underlying Slack ingress SDK (signature verification, event
  normalization, thinking-indicator UX), consumed as a pinned GitHub
  dependency, not vendored.
