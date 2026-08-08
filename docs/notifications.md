# Notifications

A notification is mail. There is no notification bus, no notification feed,
and no second copy of "things that need you" — the durable record is always a
message in somebody's mailbox, and everything else (an unread count, a push to
Slack, an end-of-day digest) is a read of that mailbox or a fan-out from it.

## Approval is "needs you"

The platform already has the concept. A workflow run that parks on a signal is
represented by a `signal_correlation` row and an `approval` row, written
together by Interchange's own register co-write. That pair **is** the needs-you
state. `@corbits/notify` invents no sibling concept, widens no approval kind,
and registers no correlation of its own. It adds exactly one step the platform
was missing: an approval exists, therefore the people who can resolve it have
mail.

Two other things reach a person the same way and are simpler, because they
have nothing to resolve: a run that failed, and a mention in a thread.

## The shape

```
approval / run failure / mention
        │
        ▼  parse (arktype) → render → one message per recipient
   mailbox (the durable record, per human principal)
        │
        ▼  post-commit, one row per (message, enabled sink)
   notify_dispatch  →  dispatch worker  →  a sink
```

`deliverNotification` parses its input with `NotificationEvent` before anything
is written, so an unvalidated shape can never reach a mailbox. It writes one
message per recipient, keyed on a stable external id — an approval keys off the
approval itself, so a redelivered register frame mails once and only once.

Sink fan-out is queued strictly after the mail commits, never called inline.
A sink going down cannot cost anybody a notification: the message is already in
the mailbox, and `notify_dispatch` remembers what still owes a copy.

## `notify_dispatch`

The one table this package owns, and the only new table in the design. A row is
one attempt stream for one (message, sink) pair: `pending` → `delivered`, or
`failed` with an exponential backoff, or `dead` once the attempt ceiling is hit,
the failure is not retryable, or the sink is no longer registered at all. It is
bookkeeping, not an event log — the fact lives in the mail row it points at.

With no sink registered, `deliverNotification` queues zero rows and the worker
finds nothing due. That is the correct steady state of a fresh install.

## Adding a sink

A sink is a package, not a case in a switch. It exports a
`NotificationSinkPlugin` — a name, `isEnabledFor(scope)`, and `deliver(ctx)` —
and the hub's composition root registers it:

```ts
import { createSlackNotificationSink } from "@corbits/notify-sink-slack";

sinks.register(createSlackNotificationSink(deps));
```

That one line is also the approval gate. Installing a sink is a reviewed change
to the composition root, which is why there is no per-send approval prompt: a
notification about needing a human cannot itself wait on a human.

Nothing inside `@corbits/notify` changes when a sink is added. The registry
holds plugins by name, refuses two sinks with the same name, and the worker
resolves a queued row's sink by that name.

## Authorization

Reading is structural. A mailbox is scoped to a single principal by
construction, so there is no cross-principal read path to guard.

Emitting is checked. `resolveNotifyContext` authorizes the principal against
the platform's own grants — resource `notify:<sinkName>`, action `deliver`,
evaluated by `@intx/authz` exactly like `approval:<deploymentId>` is — and then
resolves the sink's credential. Each of the three ways this can fail has its
own named error: `NotifyGrantMissingError`,
`NotifySinkNotConfiguredError`, `NotifySinkCredentialInvalidError`.

## What a person sees

Subjects and bodies are written for a reader: `Approve "send_invoice"?`,
`"Nightly digest" failed`, `Sawyer mentioned you in "Launch plan"`. Identifiers
never appear in what is displayed — they travel in the message's `refs`, where
the interface uses them to navigate and nothing else.
