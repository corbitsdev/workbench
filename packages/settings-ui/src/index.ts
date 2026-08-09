export { SettingsShell, resolveActiveSection } from "./shell";
export type { SettingsContext, SettingsSection } from "./shell";

export { BenchSection, BenchSectionView } from "./bench-section";
export { ChatSection, ChatSectionView } from "./chat-section";
export { AccountSection, AccountSectionView } from "./account-section";
export {
  PeopleSection,
  PeopleTable,
  InvitePersonDialog,
} from "./people-section";
export {
  RolesSection,
  RolesTable,
  RoleAssignments,
  CreateRoleDialog,
} from "./roles-section";
export {
  GrantsSection,
  GrantsTable,
  CreateGrantDialog,
} from "./grants-section";
export {
  CredentialsSection,
  CredentialsTable,
  CreateCredentialDialog,
} from "./credentials-section";

export { principalLabel } from "./identity";
export type { PrincipalLabel } from "./identity";

export { GRANT_RESOURCES, GRANT_ACTIONS } from "./resource-vocabulary";
export type { GrantResource, GrantAction } from "./resource-vocabulary";

export { useTenancyAccess } from "./access";
export type { SectionAccess, TenancyAccess } from "./access";

export {
  TenancyApiError,
  listPrincipals,
  invitePrincipal,
  updatePrincipalStatus,
  removePrincipal,
  listRoles,
  createRole,
  renameRole,
  deleteRole,
  assignRole,
  unassignRole,
  listGrants,
  createGrant,
  revokeGrant,
  evaluate,
} from "./tenancy-api";
export type {
  Principal,
  Role,
  Grant,
  GrantFilters,
  CreateGrantInput,
} from "./tenancy-api";

export {
  CredentialsApiError,
  listCredentials,
  listProviders,
  createCredential,
  deleteCredential,
} from "./credentials-api";
export type {
  Credential,
  Provider,
  CreateCredentialInput,
} from "./credentials-api";

export {
  contextWindowLabel,
  parseContextWindowInput,
  CONTEXT_WINDOW_MIN,
  CONTEXT_WINDOW_MAX,
} from "./context-window";

export { SETTINGS_STRINGS } from "./strings";

export { SettingsApiError, getAccount, renameBench } from "./api";
export type { Account, Bench } from "./api";
