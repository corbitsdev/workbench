# Linear hub tools

GTM Workbench exposes Linear through `@workbench/tools-linear`: one hub tool per
`linear_*` name in `LINEAR_HUB_TOOLS` (`packages/tools-linear/src/hub-tools.ts`).
Each tool calls the Linear GraphQL API via `fetchLinearGraphQL`; arguments are
validated with arktype at the handler boundary.

Credential resolution uses the `linear` provider at tool execution time (not at
agent launch). Agents pin `@workbench/tools-linear` and declare the tools they
need in `capabilities.tools`.

## Module layout

| File                                        | Responsibility                                                     |
| ------------------------------------------- | ------------------------------------------------------------------ |
| `hub-tools.ts`                              | `LINEAR_HUB_TOOLS` registry: definition, handler, `read` / `write` |
| `tool-runtime.ts`                           | `linearHubEntry`, `createLinearToolFor`, side-effect typing        |
| `client.ts`                                 | GraphQL transport and error formatting                             |
| `shared.ts`                                 | Config validation, `parseArgs`, JSON result helpers                |
| `pagination.ts`                             | List `first` / `after` cursor helpers                              |
| `issues.ts`                                 | Issue list, get, create, update, archive, delete, relations        |
| `comments.ts`                               | Issue comments list and create/update (`linear_save_comment`)      |
| `attachments.ts`                            | Get attachment; prepare upload; link upload to issue               |
| `documents.ts`                              | Document list, get, create/update (`linear_save_document`)         |
| `projects.ts`                               | Project list, get, create/update (`linear_save_project`)           |
| `milestones.ts`                             | Milestone list and create/update (`linear_save_milestone`)         |
| `initiatives.ts`                            | Initiative list and create/update (`linear_save_initiative`)       |
| `releases.ts`                               | Release list and create/update (`linear_save_release`)             |
| `cycles.ts`                                 | Team cycle list (read-only)                                        |
| `teams.ts`                                  | Team list and get                                                  |
| `users.ts`                                  | User list and get                                                  |
| `labels.ts`                                 | Issue, project, and initiative labels; create issue label          |
| `statuses.ts`                               | Team workflow states list and resolve by name                      |
| `search.ts`                                 | Issue search by term                                               |
| `views.ts`                                  | Saved views list (read-only)                                       |
| `webhooks.ts`                               | Webhook list, create/update, delete                                |
| `integrations.ts`                           | Workspace integration metadata (read-only)                         |
| `analytics.ts`                              | Dashboard list (may return unsupported marker)                     |
| `interchange-tools.ts` / `tool-manifest.ts` | Sidecar package wiring                                             |

## Tool catalog (42 tools)

Side effects come from `LINEAR_HUB_TOOLS`. **Write** tools mutate Linear (or
prepare mutations such as signed upload URLs) and are classified
`sideEffect: "write"`. The hub derives approval-gated LLM-safe names
(`linear__<name>`) from that classification; interactive sessions run writes
through ReviewGate unless workflow grants use `allow`.

### Issues

| Tool                   | Side effect |
| ---------------------- | ----------- |
| `linear_list_issues`   | read        |
| `linear_get_issue`     | read        |
| `linear_create_issue`  | write       |
| `linear_update_issue`  | write       |
| `linear_archive_issue` | write       |
| `linear_delete_issue`  | write       |
| `linear_link_issues`   | write       |

`linear_get_issue` with `includeRelations: true` returns this issue's **outbound**
relation edges only (blocks, related, duplicate). Inverse edges (for example
blocked-by created from the other issue) are not included; query the related
issue to see those.

`linear_list_issues` responses carry a top-level `scope` object describing the
effective query. `scope.directFilters` echoes the GraphQL `IssueFilter` sent
(`null` when unfiltered; brief-shaped calls report the post-aliasing filter,
so `createdAfter` appears as an `updatedAt.gt` bound when `updatedAfter` is
absent). `scope.teamScope.teamId` is the resolved team id (`null` for
workspace-wide queries). `scope.savedView` is `{ applied: false }` when no
saved view scoped the results, or `{ applied: true, id, name }` when one did;
view-scoped input arrives via CL-8905.

### Comments and attachments

| Tool                                   | Side effect |
| -------------------------------------- | ----------- |
| `linear_list_comments`                 | read        |
| `linear_save_comment`                  | write       |
| `linear_get_attachment`                | read        |
| `linear_prepare_attachment_upload`     | write       |
| `linear_create_attachment_from_upload` | write       |

### Documents, projects, milestones, initiatives, releases

| Tool                      | Side effect |
| ------------------------- | ----------- |
| `linear_list_documents`   | read        |
| `linear_get_document`     | read        |
| `linear_save_document`    | write       |
| `linear_list_projects`    | read        |
| `linear_get_project`      | read        |
| `linear_save_project`     | write       |
| `linear_list_milestones`  | read        |
| `linear_save_milestone`   | write       |
| `linear_list_initiatives` | read        |
| `linear_save_initiative`  | write       |
| `linear_list_releases`    | read        |
| `linear_save_release`     | write       |

### Teams, users, cycles, labels, workflow states

| Tool                            | Side effect |
| ------------------------------- | ----------- |
| `linear_list_teams`             | read        |
| `linear_get_team`               | read        |
| `linear_list_users`             | read        |
| `linear_get_user`               | read        |
| `linear_list_cycles`            | read        |
| `linear_list_issue_labels`      | read        |
| `linear_create_issue_label`     | write       |
| `linear_list_project_labels`    | read        |
| `linear_list_initiative_labels` | read        |
| `linear_list_issue_statuses`    | read        |
| `linear_get_issue_status`       | read        |

### Search, views, webhooks, analytics

| Tool                       | Side effect |
| -------------------------- | ----------- |
| `linear_search`            | read        |
| `linear_list_views`        | read        |
| `linear_list_webhooks`     | read        |
| `linear_list_integrations` | read        |
| `linear_save_webhook`      | write       |
| `linear_delete_webhook`    | write       |
| `linear_list_dashboards`   | read        |

## Read vs write summary

- **26 read tools** — GraphQL queries only; no Linear mutations.
- **16 write tools** — create, update, save, delete, archive, link, upload-prep,
  and webhook mutations as listed above.

There are **no stub tools**: every registered name maps to a real handler. If a
capability is not in this catalog, agents cannot call it under a `linear_*` name.

## Unsupported Linear operations (no hub tools)

The matrix below lists common Linear GraphQL / product areas that are **not**
exposed as workbench hub tools. The package does not ship placeholder tools that
return fake success; callers must use the Linear UI, a future tool addition, or
another integration.

| Area                                                                         | Examples not wrapped as `linear_*`                                  | Notes                                               |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------- | --------------------------------------------------- |
| Comment delete                                                               | `commentDelete`                                                     | `linear_save_comment` creates/updates only          |
| Attachment delete                                                            | `attachmentDelete`                                                  | Upload path is prepare + create-from-upload only    |
| Inline / multi-parent comments                                               | Comments on project, initiative, document, milestone, status update | `linear_list_comments` is issue-scoped              |
| Customers                                                                    | Customer CRUD, customer needs                                       | Not in package                                      |
| Diffs / reviews                                                              | Pull request diff threads, review URLs                              | Not in package                                      |
| Release pipelines & notes                                                    | Pipeline list, release get, release notes CRUD                      | Only `linear_list_releases` / `linear_save_release` |
| Project / initiative status updates                                          | Status update list, save, delete                                    | Not in package                                      |
| Initiative label create                                                      | `initiativeLabelCreate`                                             | List-only for initiative labels                     |
| Milestone / release get-by-id                                                | Single-entity fetch tools                                           | List + save patterns only where noted               |
| Cycles                                                                       | Cycle create/update/archive                                         | `linear_list_cycles` only                           |
| Views                                                                        | View create/update/delete                                           | `linear_list_views` only                            |
| Agent skills                                                                 | Linear Agent skill list/get                                         | Not in package                                      |
| Docs search                                                                  | `searchDocumentation`                                               | Not in package                                      |
| OAuth apps, notifications, favorites, time tracking, templates, triage rules | Various admin / UX APIs                                             | Not in package                                      |

### Conditional: analytics dashboards

`linear_list_dashboards` performs a real `dashboards` query. If the token or API
plan does not expose analytics, the handler returns a structured result
`{ unsupported: true, reason, detail }` rather than registering a separate stub
tool. That is the only read tool with an explicit unsupported fallback in the
implementation (`packages/tools-linear/src/analytics.ts`).

## Related docs

- Package contract: `packages/tools-linear/README.md`, `packages/tools-linear/AGENTS.md`
- Adding tools: `docs/CREATING_AGENTS_AND_TOOLS.md`
- Operator credentials: `docs/ADMIN_CLI.md`
