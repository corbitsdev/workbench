# `@workbench/web`

The workbench's single-page interface: every screen and route lives here,
composed from `@corbits/react-ui`, and builds to a static bundle in `dist/`
(`vite build`). It is a Vite SPA over the hub's `/api` — product rules live in
packages, while this app stays a generic composition of routing, shell chrome,
and client convergence over stock hub routes (see [AGENTS.md](../../AGENTS.md)
and [apps/web/AGENTS.md](AGENTS.md)). In dev, `vite dev` serves the SPA and
proxies `/api` to a locally running hub; in e2e, `e2e/lib/browser.ts` builds
and serves `dist/` on the same origin as the hub.

## Layout

Signed-in screens render inside `AppShell` (`src/shell/app-shell.tsx`),
following [DESIGN.md](../../DESIGN.md):

1. **Sidebar** (`src/shell/sidebar.tsx`) — `Workbench` wordmark with search
   (command palette) and `+` (`/new`), the **Workbenches** list, the
   **Workers** list, and a footer with the account menu (Settings, Light /
   Dark / Canvas theme picker, Sign out) and the **Tools** button.
2. **Main stage** — the active route (`src/routes.tsx`), with a `StageTopBar`
   on non-bench pages and a centered conversation column on workbenches.
3. **Canvas column** (`src/shell/canvas-column.tsx`) — an optional right-hand
   side panel for artifact previews/editing, worker profiles, and workflow
   details, plus the bench drawer and thread replies inside a workbench.

## Screens

| Path          | What it shows                                                                                     |
| ------------- | ------------------------------------------------------------------------------------------------- |
| `/`           | Ensures a personal bench and redirects to the active workbench.                                   |
| `/new`        | New workbench picker.                                                                             |
| `/w/:bench`   | Workbench conversation thread, inline approvals, voice mode, and bench drawer.                    |
| `/workers`    | Workspace workers roster (`/workers/:worker` for a worker's detail page).                         |
| `/workflows`  | Workflows and scheduled routines (`/workflows/:routine` for a workflow's detail page).            |
| `/artifacts`  | Artifact gallery and viewer (`/artifacts/:id`), backed by `/api/tenants/:id/artifacts`.           |
| `/skills`     | Skills catalog and editor (`/skills/:slug`).                                                      |
| `/tools`      | Connected MCP servers, built-in tools, and credentials.                                           |
| `/insights`   | Bench-scoped run volume, success rate, median duration, approvals, and recent failures.           |
| `/settings`   | Account, workspace members, inference providers, and access policy (presented as a modal dialog). |
| `/login`      | Sign-in and sign-up screen.                                                                       |
| `/onboarding` | First-login provider setup flow.                                                                  |

Retired path prefixes (`/mission-control`, `/inbox`, `/routines`, `/files`,
`/library`, `/settings/agents`, `/settings/skills`) redirect to their current
locations in `redirectTargetFor` (`src/routes.tsx`).

## Tests

Unit tests sit next to the source files they cover under `src/**/*.test.ts`;
browser end-to-end suites live in `e2e/browser/`.

```sh
cd apps/web && bun test
bun test e2e/browser
```
