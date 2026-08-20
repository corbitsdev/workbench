export {
  DEFAULT_ACCESS_POLICY,
  AccessPolicy,
  UpdateAccessPolicy,
  SelfSignupMode,
  TenancyCreationMode,
  CreatePendingInvite,
} from "./types";
export type { PendingInvite } from "./types";

export {
  resolveAccessPolicy,
  domainOf,
  domainAllowed,
  evaluateSignupGate,
  canCreateTenancy,
  parseAllowedDomainsColumn,
  serializeAllowedDomains,
} from "./policy";
export type {
  SignupGateArgs,
  SignupGateReason,
  SignupGateResult,
} from "./policy";

export {
  createDrizzleAccessPolicyStore,
  createInMemoryAccessPolicyStore,
} from "./store";
export type { AccessPolicyStore } from "./store";

export { checkSignupGate, resolvePendingInviteOnLogin } from "./gate";
export type { PendingInviteResolution, SignupGateCheckArgs } from "./gate";

export { createAccessPolicyRoutes } from "./routes";
export type { CreateAccessPolicyRoutesDeps } from "./routes";

export { accessPolicySchema, policy, pendingInvite } from "./schema";

export {
  accessPolicyMigrations,
  applyAccessPolicyMigrations,
} from "./migrations";
export type {
  AccessPolicyMigration,
  ApplyAccessPolicyMigrationsReport,
} from "./migrations";
