# @workbench/tools-linear

Linear API tools for workbench agents.

- Read-only: `linear_list_issues`, `linear_get_issue`, `linear_list_teams`,
  `linear_list_users`.
- Write (approval-gated): `linear_create_issue` creates a real Linear issue.
  It is classified `sideEffect: "write"`, so the hub routes it through the human
  ReviewGate before it runs — no custom gate or grant is added.
