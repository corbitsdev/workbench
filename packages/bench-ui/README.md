# @corbits/bench-ui

Bench (tenant) management UI: the bench switcher, bench creation, and
member/invite management, built over Interchange's native tenancy routes.
Presentational primitives (buttons, dialogs, listboxes) come from
`@corbits/react-ui`
([corbitsdev/react-ui](https://github.com/corbitsdev/react-ui)); this
package holds the workbench-specific composition and the tenancy HTTP
client on top of them.

## Key modules

- `bench-switcher.tsx` — the sidebar's bench dock: trigger plus popover to
  switch benches or create a new one
- `create-bench-dialog.tsx` — the new-bench flow
- `member-list.tsx` / `members-panel.tsx` / `invite-member-dialog.tsx` —
  viewing, inviting, and managing bench membership
- `membership.ts` — pure helpers: slug derivation, membership display,
  role labels
- `tenancy-kind.ts` — classifying a membership by tenancy kind
- `tenancy-contracts.ts` — shared tenancy constants and validation (roles,
  signup mode, DM channel naming, parent-tenant cycle checks)
- `api.ts` — the bench HTTP client: memberships, creation, members,
  settings

## Running tests

```
cd packages/bench-ui && bun test
```

Suites render with `react-dom/server`'s `renderToStaticMarkup` rather than
a mounted DOM, so no `bunfig.toml` preload is needed here.
