# @corbits/agent-lifecycle

A host-agnostic idle-sleep and wake-on-mail scheduler for launched agent
instances: a periodic sweep that tears down addresses idle past a
configured threshold, and `ensureAwake`, which redeploys an address on
demand and coalesces concurrent callers onto one in-flight wake. Every
side effect that touches a real host — whether an address is currently
deployed, tearing one down, redeploying one, whether one is mid-turn —
arrives as an injected port; this package never imports a hub, a sidecar,
or `@corbits/chat`.

## Composing with `@intx/*`

Only `@intx/log` — this package takes a `Logger` (the type returned by
`@intx/log`'s `getLogger`) for the sweep's info/error lines, and holds no
other Interchange dependency. It reimplements no Interchange capability;
deployment, undeploy, and wake are entirely the host's own closures.

## Key modules

- **`src/index.ts`** — the whole package: `createAgentLifecycle`, its
  `AgentLifecycle` return type (`track`, `untrack`, `recordActivity`,
  `ensureAwake`, `stop`), and the `CreateAgentLifecycleOptions` the host
  supplies (`idleSleepMs`, `isRoutable`, `undeploy`, `wake`, optional
  `sweepIntervalMs`/`isBusy`, `log`).

## What the host must inject

`isRoutable(address)`, `undeploy(address, reason)`, `wake(address)`, and a
`log`; `sweepIntervalMs` and `isBusy` are optional. `packages/chat`'s
platform adapter wires its own closures in exactly this shape.

## Running tests

```sh
cd packages/agent-lifecycle && bun test
```

Tests exercise the sweep and wake-coalescing logic directly against fake
`isRoutable`/`undeploy`/`wake` closures; no database is involved.
