# Settings section registry

`apps/web/src/settings/section-registry.tsx` collapsed Personal/Workspace
into one account-scoped group and one shared group: there is one workbench
per account now, so "workspace-scoped" and "account-scoped" name the same
tenant's settings.

Shared Settings leads with what everyone inherits (credentials, then
People) and tucks access-control mechanics (Roles, Grants, Audit) under a
collapsed Advanced disclosure — nobody should have to parse grants and
roles just to find where a shared API key lives.

Bench dies outright: there's no longer a second thing to name, distinct
from the account, so its rename/purpose/icon form and member list have no
home to keep them separate in. Conversation-scoped settings (agent,
capabilities, history) live on the workbench's own settings surface
instead.
