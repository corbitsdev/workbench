# Sidecar provisioners

A **sidecar** is the execution host a tenant's agents and workflow runs
actually run on. A **provisioner** is the backend that creates and
destroys one — Interchange's `SidecarProvisioner` contract.

## The shipped backends

| id        | Where a sidecar runs                    | Isolation                                      | Requires                                                | Module                                   |
| --------- | ---------------------------------------- | ----------------------------------------------- | -------------------------------------------------------- | ----------------------------------------- |
| `process` | A child process of the hub, same host    | Process only — shared kernel, filesystem, user  | nothing                                                   | `apps/hub/src/provisioners/process.ts`    |
| `docker`  | A container on the hub's host            | Container — own filesystem and network namespace | `DOCKER_PROVISIONER_IMAGE`, a local `docker` CLI          | `apps/hub/src/provisioners/docker.ts`     |
| `e2b`     | A remote [E2B](https://e2b.dev) sandbox  | VM — separate machine                            | `E2B_API_KEY`, `E2B_TEMPLATE`, a publicly reachable hub   | `apps/hub/src/provisioners/e2b.ts`        |

The docker backend's sidecar image builds from `apps/sidecar-docker/`; the
e2b backend's sandbox template builds from `apps/sidecar-e2b/template/`.
Both are asset-only apps the hub does not import — `buildSidecarProvisioner`
in `apps/hub/src/server.ts` imports the provisioner logic straight from
`apps/hub/src/provisioners/`.

`process` is the default: with `SIDECAR_PROVISIONERS` unset, the hub
registers it alone, so one server runs many tenants with no operator
configuration. Pick `docker` or `e2b` when a sidecar runs untrusted code
or needs its own filesystem and network.

## Configuring it

```sh
# Register a set of backends. Unset means exactly `process`.
SIDECAR_PROVISIONERS=process,docker
# Which of them exclusive placements provision on. Optional when the list
# has one id; required when it has more.
SIDECAR_DEFAULT_PROVISIONER=docker
```

`SIDECAR_PROVISIONERS` replaces the default rather than adding to it —
list `process` explicitly to keep it alongside another backend. An
unknown id, a missing backend setting, or a default naming an unlisted id
all fail boot with a message naming the variable. Per-backend settings
are documented in `.env.example` and `apps/hub/src/config.ts`.

### Capability matching

Interchange selects a provisioner by matching a deployment's required
capabilities against what each registered backend declares, failing
closed when nothing matches. The shipped backends form a ladder
(`isolation:process` → `isolation:container` → `isolation:vm`): each
reaches its own rung and below, never above.

| Declaration           | `process`   | `docker`    | `e2b`     |
| ---------------------- | ----------- | ----------- | --------- |
| `isolation:process`    | available   | available   | available |
| `isolation:container`  | blocked     | available   | available |
| `isolation:vm`         | blocked     | blocked     | available |

## Adding a backend

1. Implement a `SidecarBackend` (copy `apps/hub/src/provisioners/process.ts`)
   — idempotence, generation fencing, and destroy tombstones come from
   `apps/hub/src/provisioners/sandbox-sidecar.ts`'s shared core.
2. Add a case to `buildSidecarProvisioner` in `apps/hub/src/server.ts`,
   with its own required settings parsed there.
3. If the backend needs its own image or template assets, add them to a
   new `apps/sidecar-<backend>/` app; the hub itself never imports it.

No other hub surgery is needed.
