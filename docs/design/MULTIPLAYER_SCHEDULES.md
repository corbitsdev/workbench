# Multiplayer schedules — Just for me | Everyone

Product contract for schedule **scope** (CL-4111). Implementation tracks
CL-4108 (data model), CL-4110 (kind `allowedScopes`), CL-4112 (attach UX),
CL-4114 (tenant-once fire + subscribe fan-out).

## Labels

| UI label        | Internal `scope` | Who the run is for                          |
| --------------- | ---------------- | ------------------------------------------- |
| **Just for me** | `personal`       | One principal owns the schedule and the run |
| **Everyone**    | `tenant`         | One tenant-scoped fire; outcomes fan out    |

**Team ≡ Tenant** in this product. Do not invent a third "team" scope.

## Fork semantics

Scope is chosen **at attach time**. It is not a visibility toggle on an
already-personal run.

- **Just for me** — one schedule row owned by the member; one run per fire;
  outcome mail to that member (existing notify prefs).
- **Everyone** — one schedule row per `(tenant, kind)` with `scope = tenant`;
  **exactly one workflow run** per due tick; **subscribe** delivery of outcomes
  into principal inboxes (v1: every Myra-provisioned member of the tenant).

**Everyone is not N parallel runs.** Member count must never multiply runs.

## Kind policy

Each catalog kind declares:

- `allowedScopes: ("personal" | "tenant")[]`
- `defaultScope: "personal" | "tenant"` (must be ∈ `allowedScopes`)

Defaults when a kind does not opt in:

- `allowedScopes: ["personal"]`
- `defaultScope: "personal"`

Heartbeat stays personal-only (member identity + brief sources). Attachable
kinds that are not personal-identity-bound may allow both scopes.

## Uniqueness

| Scope      | Unique key                                     |
| ---------- | ---------------------------------------------- |
| `personal` | `(tenant_id, owner_member_principal_id, kind)` |
| `tenant`   | `(tenant_id, kind)`                            |

A member may hold a personal schedule for kind K while a separate tenant
schedule for K also exists.

## Non-goals (this slice)

- Per-subscriber opt-in table beyond "all Myra members" (later)
- Owner fire heatmap visualization (optional stretch of CL-4113; v1 is the list)
- Replacing personal heartbeats that re-poll shared sources (CL-4109)
- Durable work-queue lanes (CL-4070+) — schedule fire still starts a workflow run
