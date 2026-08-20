# @corbits/tasks-ui

The task composer surface: pick an agent, write a prompt, optionally pick
a model, and launch a task against `@corbits/tasks`' HTTP routes.
Submitting closes the dialog immediately — a task is spawn-and-return, its
result reaches the caller later through the Inbox, never through a live
view in this dialog. Presentational primitives come from `@corbits/react-ui`
([corbitsdev/react-ui](https://github.com/corbitsdev/react-ui)); this
package holds the workbench-specific composition and the tasks HTTP client.

## Key modules

- `task-composer-dialog.tsx` — the "New task" dialog: agent picker, prompt,
  and the model select (shown only when the tenant's model catalog offers
  more than one option)
- `agent-selection-strategy.tsx` — `createManualAgentSelectionStrategy`,
  the pluggable interface a host's agent picker implements
- `myra-agent-selection-strategy.tsx` — a concrete agent-selection strategy
  with an auto-selection option
- `working-task.ts` / `working-task-row.tsx` — the in-flight task type and
  its row rendering (elapsed time, "needs you" status)
- `api.ts` — the tasks HTTP client: create/get/list tasks, the planner
  dispatch, and the catalog-model list

## Running tests

```
cd packages/tasks-ui && bun test
```

Several suites mount into a real DOM (see `test/dom-setup.ts`); running
from the package directory picks up `bunfig.toml`'s preload.
