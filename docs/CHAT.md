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

Parts are encoded onto the platform's own mail-send shape: a message that is
a single text part rides as bare mail content; anything else — multiple
parts, or one non-text part — becomes a list of MIME attachments, each
`text/plain` or `application/json`. Reading mail back decodes the
platform's JMAP-style response the same way, so callers always see the same
`Part[]` shape regardless of which side of the wire produced it.

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

## The HTTP surface

`@corbits/chat` mounts one router, under a tenant-scoped prefix, with the
following routes:

| Method & path                  | What it does                                                               |
| ------------------------------ | -------------------------------------------------------------------------- |
| `POST /channels`               | Creates a channel: launches its host and writes its initial settings       |
| `GET /channels`                | Lists the tenant's channels, optionally filtered by kind                   |
| `GET /channels/:id/messages`   | Reads the channel's timeline, decoded into parts, paginated by cursor      |
| `POST /channels/:id/messages`  | Posts a message, fanning a copy to every @mentioned agent participant      |
| `GET /channels/:id/invitable`  | Lists the tenant's deployed definitions that can be invited into a channel |
| `POST /channels/:id/invite`    | Launches a definition into the channel and adds it as a participant        |
| `GET /channels/:id/settings`   | Reads a channel's settings                                                 |
| `PATCH /channels/:id/settings` | Updates settings, recording each change as a timeline event                |
| `GET /channels/:id/read-state` | Reads the calling principal's last-seen cursor for the channel             |
| `PUT /channels/:id/read-state` | Advances the calling principal's last-seen cursor                          |
| `POST /channels/:id/typing`    | Publishes an ephemeral typing indicator to the channel's live stream       |
| `GET /channels/:id/stream`     | Server-Sent Events stream of live channel activity                         |

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
its own routing:

```tsx
import { ChatWorkspace } from "@corbits/chat-ui";

<ChatWorkspace
  tenant={tenant}
  currentUser={{ principalId }}
  channelId={channelId}
  onChannelChange={(channelId) => navigate(`/chat/${channelId}`)}
/>;
```

`ChatWorkspace` talks to `@corbits/chat`'s HTTP surface directly — a host
does not hand it a client or re-derive its API calls, only tell it where to
send them and who is asking.
