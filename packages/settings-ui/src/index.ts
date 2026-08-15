export {
  SettingsShell,
  resolveActiveSection,
  flattenSettingsSections,
} from "./shell";
export type {
  SettingsContext,
  SettingsSection,
  SettingsSectionGroup,
} from "./shell";

export {
  resolveSettingsSectionGroups,
  insertWorkspaceSections,
} from "./section-registry";

export { BenchSection, BenchSectionView } from "./bench-section";
export { ChatSection, ChatSectionView } from "./chat-section";
export { AccountSection, AccountSectionView } from "./account-section";
export { NotificationsSection } from "./notifications-section";
export { AuditSection } from "./audit-section";
export { AccessPolicyBlock, AccessPolicyEditor } from "./access-policy";
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
export {
  ConnectionsSection,
  ConnectorCardGrid,
  ConnectorCredentialDialog,
} from "./connections-section";

export { GranolaWebhookCard } from "./granola-webhook-card";

export {
  CopyButton,
  CopyableCodeRow,
  WebhookSecretPanel,
} from "./webhook-secret-panel";

export {
  grantPreviewSentence,
  expiryIsoFromPreset,
  expiryLabelFromPreset,
} from "./grant-preview";
export type { GrantPreviewInput } from "./grant-preview";
export { KindCards } from "./kind-cards";
export type { KindCardOption } from "./kind-cards";

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
  ConnectionsApiError,
  testConnectorCredential,
  completeConnectorCredential,
} from "./connections-api";

export { connectorStatus } from "./connections-status";
export type {
  ConnectorStatus,
  ConnectorStatusResult,
} from "./connections-status";

export { CONNECTOR_PINNED_WORKFLOWS } from "./connections-pinned-by";

export {
  contextWindowLabel,
  parseContextWindowInput,
  CONTEXT_WINDOW_MIN,
  CONTEXT_WINDOW_MAX,
} from "./context-window";

export { SETTINGS_STRINGS } from "./strings";

export {
  SettingsApiError,
  getAccount,
  getAuthConfig,
  renameBench,
} from "./api";
export type { Account, AuthConfig, Bench } from "./api";
