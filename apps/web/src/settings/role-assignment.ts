// Pure logic behind the Roles assignment UI: kind-qualified labels so
// machine principals never read as people, users-first ordering for the
// picker, and the failure message that distinguishes a missing (never
// minted) principal from a transient error.

import { PRINCIPAL_KIND_LABEL, PRINCIPAL_KIND_ORDER, principalLabel } from "./identity";
import { SETTINGS_STRINGS } from "./strings";
import { isNotFoundError, type Principal } from "./tenancy-api";

/**
 * A 404 from the assign endpoint means the hub has no such principal (or
 * role) in this tenant -- for machine principals that usually means the
 * account has not been minted yet, because agent and workflow principals are
 * created on their first run rather than at deploy time. Any other failure
 * is reported as transient. Still fail-closed: both branches only choose the
 * message shown next to the untouched assignment table.
 */
export function assignFailureMessage(cause: unknown): string {
  if (isNotFoundError(cause)) return SETTINGS_STRINGS.rolesAssignMissingPrincipalError;
  return SETTINGS_STRINGS.rolesAssignError;
}

/** "Deploy Bot — Agent": machine principals are never shown as bare people,
 * matching the grants picker's kind-qualified labels. */
export function assignmentPrincipalLabel(principal: Principal): string {
  const { label } = principalLabel(principal.displayName);
  if (principal.kind === "user") return label;
  return `${label} — ${PRINCIPAL_KIND_LABEL[principal.kind]}`;
}

export function compareAssignmentPrincipals(a: Principal, b: Principal): number {
  const kindOrder = PRINCIPAL_KIND_ORDER.indexOf(a.kind) - PRINCIPAL_KIND_ORDER.indexOf(b.kind);
  if (kindOrder !== 0) return kindOrder;
  return assignmentPrincipalLabel(a).localeCompare(assignmentPrincipalLabel(b));
}
