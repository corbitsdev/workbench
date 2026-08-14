# Chat

Chat is Workbench's shared conversation surface: teams and agents read and
write the same timeline, in the same [bench](GLOSSARY.md), through the same
mail-based transport Interchange already gives every agent. It ships as two
packages — `@corbits/chat` (the HTTP surface and domain logic) and
`@corbits/chat-ui` (the React components a host renders it with) — composed
onto the hub and the web app respectively.

## What a channel is

A channel is a credential-free, folded interactive instance: a single
long-lived agent run whose only job is to hold a mailbox. Creating a channel
launches this instance (its **channel host**, sometimes called its anchor)
and every message sent to the channel is mail delivered to that instance's
address. The host's system prompt forbids it from ever replying, commenting,
or acting — it exists purely to give the channel a durable, listable
mailbox. That mailbox, read back in order, is the channel's **timeline**.

Because a channel is an ordinary folded run, it goes through the same
launch, addressing, and mail machinery any other interactive agent run
uses — chat adds no parallel transport of its own.

A channel is also its own tenant, parented under the bench it was created
in, so its membership and permissions are native grants rather than a
chat-specific system — see [channel-tenancy.md](channel-tenancy.md) for
the mint, listing, and move mechanics.

```mermaid
flowchart LR
    subgraph Channel
        Host[Channel host<br/>anchor run]
    end
    Alice[Human participant] -->|mail| Host
    Bot["@handle agent participant"] -->|mail| Host
    Host -->|timeline read| UI[Chat UI]
    Host -.->|mention fan-out copy| Bot
    Bot -.->|connector.reply, bridged| Host
```

## The message model

A message is a list of MIME parts, not a single string. The parts a channel
supports:

- **text** — plain message text.
- **event** — a structured, machine-readable record (e.g. a participant
  joining, a settings change) rendered distinctly from authored text.
- **attachment / file** — a named blob with a media type, referenced by id
  rather than inlined, so large files are never pulled into memory just to
  render a message list.
- **block** — a generative UI card: a `{ type, data }` envelope whose data
  is agent-authored JSON, never markup or code. The typed vocabulary lives
  in `@corbits/chat`'s `blocks` module — `approve`, `steps`, `metrics`,
  `poll`, `form`, and `stream` — and `@corbits/chat-ui` renders each type
  through a closed component registry, parsing the data at the render
  boundary so an unknown type or malformed payload degrades to a labeled
  fallback card. An approve block carries only a reference to a platform
  approval plus the agent's framing (title, risk, body): action labels are
  fixed by the client and the decision's state lives on the approval
  record, never in the message. Poll choices carry no agent-authored
  tallies. Blocks render read-only today; their controls stay disabled
  until the action round-trip ships.

Parts are encoded onto the platform's own mail-send shape: a message that is
a single text part rides as bare mail content; anything else — multiple
parts, or one non-text part — becomes a list of MIME attachments, each
`text/plain` or `application/json`. Reading mail back decodes the
platform's JMAP-style response the same way, so callers always see the same
`Part[]` shape regardless of which side of the wire produced it.

## Threads: channel → thread → sub-thread

A channel's timeline is itself a thread — its **root thread**, one per
channel, created lazily on first use. Any message can be replied to, which
opens (or reuses) a **depth-1 thread** anchored on that message; any message
_inside_ a depth-1 thread can be **forked**, which opens (or reuses) a
**depth-2 sub-thread** anchored on that message. That's the whole model —
channel → thread → sub-thread, stop. There is no depth 3 (owner ruling,
CL-5908): nesting a reply off a message that already lives in a sub-thread
is rejected with an honest `409 conflict` rather than silently growing a
third level.

Forking is the first-class affordance CL-5948 adds — "something Slack
doesn't have": any message inside a thread offers **Fork**, spawning a
sub-thread rooted at it. Forking from a message already inside a sub-thread
never creates a third level; it redirects to a **sibling sub-thread** under
that sub-thread's same depth-1 parent instead. Both the redirect and the
409 share one piece of pure logic, `resolveThreadAnchor` in
`packages/chat/src/threads.ts`: given the root thread and the thread a
message currently lives in, it returns where a new thread should hang and
whether that would be a third level. `openReplyThread` (implicit replies)
refuses on that signal; `forkThread` (explicit forks) redirects on it —
neither reimplements depth math.

Every non-root thread carries a `parentThreadId` — the thread it hangs
directly off (the root thread's id for a depth-1 thread, a depth-1 thread's
id for a depth-2 sub-thread) — alongside its existing `parentMessageId`,
the origin message it answers or forks. `@corbits/chat-ui` reads
`parentThreadId` to render the breadcrumb (`Channel / Thread / Sub-thread`,
at most three segments), to walk a fork back to its parent thread, and to
indent sub-threads under their parent in the threads menu; a forked
sub-thread also shows a small banner above its timeline linking back to its
origin message — the fork's visible back-reference.

## Participants and mentions

A channel's participants are held in its settings as records of
`{ address, handle }`. The **handle** is the short, unique-within-channel
name a mention actually types — `@echo`, never the underlying run's
unreadable instance id. Handles are derived from a definition's name at
invite time and de-duplicated against every handle already in the channel
(`echo`, `echo-2`, `echo-3`, ...).

A **mention** is `@` followed by a participant's handle at a word boundary,
anywhere in a message's text. Mentioning an agent participant triggers
**fan-out**: the server sends that agent a single-recipient copy of the
message, addressed from the channel itself rather than from the posting
principal. Sending from the channel matters because an agent's reply
router answers the address a message came from — a principal address has
no mailbox to answer into, but the channel's address is the mailbox every
participant already reads.

## Chats and direct messages (DMs)

`kind: "chat"` is a direct thread with exactly one counterpart, fixed at
creation and never changed afterward (`POST /channels/:id/invite` 409s a
chat, whichever kind of counterpart it has). The counterpart is chosen at
`POST /channels` time, one of:

- **An agent** — `{ kind: "chat", definitionId }`. The named definition is
  launched and joined as the chat's one participant, exactly as
  `POST /channels/:id/invite` joins one into a channel (`launchAndJoinAgent`
  in `packages/chat/src/channel-service.ts`, shared by both paths).
- **A person** — `{ kind: "chat", principalId }`. This is a **DM**: a
  two-member channel tenancy whose second participant is an existing bench
  member, added directly with no instance to launch
  (`joinHumanParticipant`, the human-counterpart analog of
  `launchAndJoinAgent`) — a human participant reads the channel's own
  timeline directly, so there is no mailbox to stand up, only the
  participant record and a `channel.member-joined` audit event on the
  channel's own timeline.

Exactly one of `definitionId`/`principalId` may be present; a `principalId`
is validated before anything is minted — it must name a real, active
`"user"`-kind principal in the calling tenant, and it can never equal the
caller's own principal id (`409 conflict`, "you cannot start a direct chat
with yourself"). Both counterpart kinds are optional on `name`: an agent
chat falls back to the agent's own handle, and a person chat falls back to
the same handle its one participant record carries — in practice always the
member's display name, since `@corbits/chat-ui`'s new-chat dialog already
has it (from the same listing Settings → People renders) and sends it as
`name` whenever the person creating the chat didn't type a custom title.

**There is no `dm: true` wire flag.** A DM is recognized the same way
everywhere it matters — `kind === "chat"` plus the absence of an
agent-shaped participant address (`isAgentAddress` in
`packages/chat/src/mentions.ts`, which is simply "does this participant's
address contain `@`" — a human participant's address is its bare principal
id). The host app's sidebar buckets a DM this way already
(`assignChannelBucket` in `apps/web/src/shell/panel-contributions.tsx`), and
`@corbits/chat-ui`'s channel-settings surface trims its Agents section the
same way (`channelSettingsSections(kind, isDm)` in
`packages/chat-ui/src/channel-settings/model.ts` — a DM has no agent to
invite, so the section has nothing to show; Members and Danger zone are
already trimmed for every 1:1 chat, agent or person). One derivation, no
second signal to keep in sync.

## The reply bridge

An invited agent's reply is not something it posts back into the channel on
its own — replies surface only as `connector.reply` events on that agent's
own event stream, never as mail it sends. The **reply bridge** is the piece
that turns those events into channel messages: for each agent participant,
the platform subscribes to that agent's event stream and, on a
`connector.reply` event, posts its content into the channel's timeline as
mail from the channel (mirroring how a mention fan-out copy is sent).

The bridge is armed when an agent is invited, and idempotently re-armed
whenever a channel's messages are read — bridges are in-memory, so a host
restart loses them, and a read is the natural moment to notice and recreate
one.

## Bench defaults and per-channel overrides

A channel setting can be a bench-wide default every channel inherits, or an
explicit per-channel override — the same "Use bench default" vs. "Override"
shape Discord's server-default settings use. Today this applies to exactly
one setting, `chat/contextWindow` (how many prior messages a mentioned
agent sees as context):

- **Bench-wide default** — `GET`/`PATCH /bench/settings` reads and writes
  the tenant's own `chat_bench_settings` row. A bench default is never
  itself an override of anything, so it is always a plain number, never
  `null`.
- **Per-channel override** — a channel's own `chat/contextWindow` in its
  settings is nullable: `null` (or the key's absence) means "inherit the
  bench default," any other integer is an explicit override for that
  channel alone.
- **Resolution** — `resolveContextWindow(channelSettings, benchDefault)` in
  `packages/chat/src/channel-settings.ts` folds the two into the one
  effective value a message send actually uses, returning both the value
  and which source it came from (`"inherit"` or `"override"`). `GET`/`PATCH
/channels/:id/settings` include this resolved `{ value, source }` shape
  on every response, so a caller never has to re-derive it from the bench
  default and the raw channel settings separately.

In the UI this resolved shape drives a two-state control — "Use bench
default (N)" vs. an explicit numeric field — on the channel's own settings
panel (opened from its header, or from its sidebar row's ellipsis menu).
The bench-wide settings page only ever edits the default itself; it carries
no per-channel editor, since a channel's override belongs to the channel.

## The HTTP surface

`@corbits/chat` mounts one router, under a tenant-scoped prefix, with the
following routes:

| Method & path                                  | What it does                                                                                                                                                                                                                    |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /channels`                               | Mints the channel's own tenant, launches its host, writes its initial settings, and — for a chat — joins its one counterpart (an agent or a person; see [Chats and direct messages](#chats-and-direct-messages-dms))            |
| `GET /channels`                                | Lists the tenant's channels, optionally filtered by kind                                                                                                                                                                        |
| `GET /channels/:id/messages`                   | Reads the channel's timeline, decoded into parts, paginated by cursor                                                                                                                                                           |
| `POST /channels/:id/messages`                  | Posts a message, fanning a copy to every @mentioned agent participant. `threadId` or `inReplyToMessageId` route it into a thread instead of the root feed; a reply that would nest past depth 2 is a `409 conflict`             |
| `GET /channels/:id/threads`                    | Lists a channel's threads (root, delivery, replies, and sub-threads) plus its root thread id                                                                                                                                    |
| `GET /channels/:id/threads/:threadId/messages` | Reads one thread's own membership, decoded into parts — never the full channel mailbox                                                                                                                                          |
| `POST /channels/:id/threads/fork`              | Forks a sub-thread rooted at any message inside a thread (CL-5948); idempotent per origin message, and redirects to a sibling sub-thread rather than nesting past depth 2 (see [Threads](#threads-channel--thread--sub-thread)) |
| `POST /channels/:id/delivery-threads`          | Creates (or reuses) the delivery thread for a routine run                                                                                                                                                                       |
| `GET /channels/:id/invitable`                  | Lists the tenant's deployed definitions that can be invited into a channel                                                                                                                                                      |
| `POST /channels/:id/invite`                    | Launches a definition into the channel and adds it as a participant                                                                                                                                                             |
| `POST /channels/:id/move`                      | Re-parents a channel's own tenant to a different bench                                                                                                                                                                          |
| `GET /channels/:id/settings`                   | Reads a channel's settings, including its resolved context window                                                                                                                                                               |
| `PATCH /channels/:id/settings`                 | Updates settings, recording each change as a timeline event                                                                                                                                                                     |
| `GET /channels/:id/read-state`                 | Reads the calling principal's last-seen cursor for the channel                                                                                                                                                                  |
| `PUT /channels/:id/read-state`                 | Advances the calling principal's last-seen cursor                                                                                                                                                                               |
| `POST /channels/:id/typing`                    | Publishes an ephemeral typing indicator to the channel's live stream                                                                                                                                                            |
| `GET /channels/:id/stream`                     | Server-Sent Events stream of live channel activity                                                                                                                                                                              |
| `GET /bench/settings`                          | Reads the tenant's bench-wide chat defaults                                                                                                                                                                                     |
| `PATCH /bench/settings`                        | Updates the tenant's bench-wide chat defaults                                                                                                                                                                                   |

Every route runs behind the hub's tenant-scoped middleware, so the calling
tenant and principal are always resolved before a handler runs; principals
never appear in a path.

## Mounting into a host

`@corbits/chat` never talks to the platform's own HTTP API or reimplements
its session, grant, or mail machinery. Instead it depends on `ChatPlatform`:
a narrow port describing exactly what the package needs — launching a
channel or an invited agent, sending and listing mail, fetching an
attachment's bytes, subscribing to live events, and arming a reply bridge.
A host composes this port from services it already builds (a session
service, an asset service, a sidecar router, and its database), and injects
it — along with a settings store and a grant check — into
`createChatRoutes` to get a mountable router back:

```ts
import {
  createChatRoutes,
  createDrizzleChatStore,
  createHubChatPlatform,
} from "@corbits/chat";

const chatRoutes = createChatRoutes({
  store: createDrizzleChatStore(db),
  platform: createHubChatPlatform({
    db,
    sessionService,
    assetService,
    sidecarRouter,
  }),
  requireGrant,
  turnTimeoutMs: 5 * 60 * 1000,
});

app.route("/api/tenants/:tenantId/chat", chatRoutes);
```

Any host that can build an equivalent `ChatPlatform` can mount chat the same
way — the port, not this hub, is the integration contract.

## Consuming it from the UI

`@corbits/chat-ui` renders the whole chat surface — sidebar, timeline,
composer, mention picker, new-channel and invite-agent dialogs, and the live
event stream — as a single `ChatWorkspace` component. A host supplies which
bench to talk to and the current user, and mirrors the active channel into
its own routing. Each sidebar row also carries a hover-revealed ellipsis
menu (Rename, Pin/Unpin, Channel settings).

Channels are tenants, so their settings are never a dialog: the gear icon
in the channel header routes to a full stage surface,
`ChannelSettingsSurface` (`packages/chat-ui/src/channel-settings/`) —
a breadcrumb back to the channel, a left nav grouped Shared / Personal /
Danger zone, and the active section's panel on the right. `ChatWorkspace`
takes `settingsOpen` and `onSettingsOpenChange` the same way it takes
`channelId` and `onChannelChange`, so the host mirrors the surface into its
own routing (`@workbench/web` mounts it at `/c/:channelId/settings`). The
General section still PATCHes name, pinned, and the inherit/override
context-window control; Members and Agents reuse the same invite flow
already in `invite-agent-dialog.tsx` rather than duplicating it.

```tsx
import { ChatWorkspace } from "@corbits/chat-ui";
import { listPrincipals } from "@corbits/settings-ui";

<ChatWorkspace
  tenant={tenant}
  currentUser={{ principalId }}
  channelId={channelId}
  onChannelChange={(channelId) => navigate(`/chat/${channelId}`)}
  settingsOpen={settingsOpen}
  onSettingsOpenChange={(open) =>
    navigate(open ? `/chat/${channelId}/settings` : `/chat/${channelId}`)
  }
  onOpenArtifact={(part) => navigate("/library")}
  listMembers={async (tenantId) => {
    const principals = await listPrincipals(tenantId);
    return principals
      .filter((p) => p.kind === "user" && p.status === "active")
      .map((p) => ({ id: p.id, displayName: p.displayName }));
  }}
/>;
```

`ChatWorkspace` talks to `@corbits/chat`'s HTTP surface directly — a host
does not hand it a client or re-derive its API calls, only tell it where to
send them and who is asking.

`listMembers` is what puts a People tab beside the new-chat dialog's
existing Agents tab: `@corbits/chat-ui` resolves no session or tenancy of
its own (see the module note atop `chat-workspace.tsx`), so the bench's
people come from the host, the same way `tenant` and `currentUser` do —
`@workbench/web` sources it from `@corbits/settings-ui`'s `listPrincipals`,
the same call Settings → People renders from. Omitted entirely, the dialog
falls back to exactly the agent-only picker it has always been — a host
that hasn't wired a member directory yet never gets a tab that silently
fails to load.

The timeline adds a day divider between messages from different calendar
days, and renders a `file` part as a clickable artifact chip once it
carries a persisted `blobId` — a still-in-flight, `data`-only attachment
renders the same chip inert, since it has no stable id yet to open. A chip
click calls the host-supplied `onOpenArtifact`, mirroring `onOpenThread`
and `onOpenProfile`: `@corbits/chat-ui` owns no router, and today a chat
blob has no stored link back to a specific Library artifact, so the most a
host can do is navigate to the Library at large — a real per-artifact deep
link (and opening in canvas rather than navigating away) is follow-up work.

A typing banner renders between the timeline and the composer, driven by
the `chat.typing` event `POST /channels/:id/typing` already publishes to
the live stream (see the HTTP surface table above) — `ChatWorkspace` tracks
the latest ping with a short expiry and resolves it to the typist's
participant handle, never a raw principal id.

The pinned/quick-action strip the shell mock shows above the message list
has no backing store yet — `@corbits/chat` only tracks whether a whole
channel is pinned in the sidebar, not a per-channel list of pinned
artifacts — so `ChatWorkspace` renders nothing there rather than fake data.
Reactions are a separate follow-up: the wire model has no reaction part or
endpoint yet.
