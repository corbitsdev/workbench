# @corbits/settings-ui

The settings surface: `SettingsShell` renders the active section's panel
only — section nav is a master-detail list that lives in the host's own
col2 (`resolveSettingsSectionGroups`), never repeated in the stage.
Presentational primitives come from `@corbits/react-ui`
([corbitsdev/react-ui](https://github.com/corbitsdev/react-ui)); this
package holds the workbench-specific section composition, HTTP clients,
and the domain model of which sections exist and who can see them.

Sections are grouped Account (personal: chat notifications, account,
connections) and Everyone (account-wide: people, roles, grants, audit) —
the single-concept collapse of the old Personal/Workspace split, since
there is one workbench per account today. `resolveSettingsSectionGroups`
is the one source of truth a host reads for both the settings stage and
its own section nav, so the two never drift; `insertEveryoneSections` lets
a host splice in its own account-wide sections (e.g. Agents/Skills)
alongside these.

## Key modules

- `shell.tsx` — the section-panel shell and `resolveActiveSection`
- `section-registry.tsx` — the Account/Everyone grouping, ordering, icons,
  and tenancy gates
- `people-section.tsx` / `roles-section.tsx` / `grants-section.tsx` /
  `credentials-section.tsx` / `connections-section.tsx` — the Everyone-group
  and account-scoped management surfaces, each with its own API module
- `account-section.tsx` / `notifications-section.tsx` / `audit-section.tsx`
  — the Account-group surfaces
- `access.ts` / `tenancy-api.ts` — tenancy-gate resolution and the
  principals/roles/grants HTTP client
- `access-policy.tsx` — the grant preview/editor shared by roles and grants

## Running tests

```
cd packages/settings-ui && bun test
```

Several suites mount into a real DOM (see `test/dom-environment.ts`);
running from the package directory picks up `bunfig.toml`'s preload.
