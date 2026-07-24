# `@workbench/workflows-ui`

Presentational building blocks for the unified **Workflows** member surface.

## React surface

Import from `@workbench/workflows-ui/react`:

| Export | Role |
| --- | --- |
| `WorkflowsList` | Dense Live + Scheduled list with filters |
| `InspectorShell` / `InspectorEmpty` | Right-rail chrome |
| `ScheduleInspectorView` | Schedule overview + edit/history slots |
| `LiveRunInspector` | Live phase chip + banner + step/gate slots |
| `KindPickerShell` | New Workflow kind cards (Mine / Everyone badges) |
| `CreateScheduleFormLayout` | Two-column create form + sticky summary |
| `GateBlock` / `StepList` | Shared gate and step timeline primitives |
| `StatusChip` / `ScopePill` / `FilterChip` | Dense list chrome |

Apps own data fetching and mutations. `apps/web` hosts:

- `WorkflowsPage` — list + inspector routing (`?schedule=`, path/`?run=`, `?new=`)
- `ConnectedScheduleInspector` / `ConnectedNewWorkflow` — schedule + create wiring
- `WorkflowRunPane` with `embedded` — live engine host inside the list inspector

Legacy `/routines` routes redirect into this surface.
