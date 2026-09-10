// The "People" settings section: every human (`kind: "user"`) principal on
// this bench, with suspend/reactivate/remove/role actions over the native
// `/api/tenants/:tenantId/principals` and `/roles` routes. Agent and
// workflow principals are machine identities, not people to manage here —
// Roles/Grants sections list every kind since those assign to machines
// too. Never renders a raw principal id or a raw agent refId — see
// `identity.ts`. New humans join only when an operator creates them
// through native APIs.

import {
  Badge,
  Button,
  ConfirmButton,
  EmptyState,
  SettingsPanel,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@corbits/react-ui";
import { useEffect, useState } from "react";

import type { APIQuery } from "@corbits/api-query";
import {
  QueryView,
  UnauthenticatedError,
  describeQueryError,
} from "@corbits/api-query";
import { reportError } from "@corbits/error-sink";
import { PRINCIPAL_KIND_LABEL, principalLabel } from "./identity";
import { AccessPolicyBlock } from "./access-policy";

import { SETTINGS_STRINGS } from "./strings";
import {
  assignRole,
  listPrincipals,
  listRoles,
  removePrincipal,
  unassignRole,
  updatePrincipalStatus,
  type Principal,
  type Role,
} from "./tenancy-api";

const STATUS_TONE: Record<Principal["status"], "success" | "info" | "neutral"> =
  {
    active: "success",
    invited: "info",
    suspended: "neutral",
    deactivated: "neutral",
  };

/** The two system roles this section's simplified role picker maps onto —
 * discovered by name from this tenant's actual roles rather than assumed,
 * since role ids are minted per tenant. */
function findSystemRole(
  roles: readonly Role[],
  name: "owner" | "member",
): Role | undefined {
  return roles.find((role) => role.name.toLowerCase() === name);
}

type PeopleData = {
  readonly people: readonly Principal[];
  readonly roles: readonly Role[];
};

export function PeopleSection({
  tenantId,
}: {
  readonly tenantId: string | null;
}) {
  const [query, setQuery] = useState<APIQuery<PeopleData>>({
    kind: "loading",
  });
  const [reloadKey, setReloadKey] = useState(0);
  const [rowError, setRowError] = useState<string | null>(null);

  function reload() {
    setReloadKey((value) => value + 1);
  }

  useEffect(() => {
    if (tenantId === null) return;
    let cancelled = false;
    setQuery({ kind: "loading" });
    Promise.all([listPrincipals(tenantId), listRoles(tenantId)])
      .then(([principals, roles]) => {
        if (!cancelled)
          setQuery({
            kind: "ready",
            data: {
              people: principals.filter((p) => p.kind === "user"),
              roles,
            },
          });
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        if (cause instanceof UnauthenticatedError) {
          setQuery({ kind: "unauthenticated" });
          return;
        }
        setQuery({
          kind: "error",
          message: describeQueryError(cause),
          retry: reload,
        });
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId, reloadKey]);

  if (tenantId === null) {
    return (
      <EmptyState
        title={SETTINGS_STRINGS.benchNoneSelectedTitle}
        description={SETTINGS_STRINGS.benchNoneSelectedDescription}
      />
    );
  }

  function handleStatusChange(
    principal: Principal,
    status: "active" | "suspended",
  ) {
    if (tenantId === null) return;
    setRowError(null);
    updatePrincipalStatus(tenantId, principal.id, status)
      .then(reload)
      .catch((cause: unknown) => {
        reportError(cause, {
          operation: "settings.people.updateStatus",
          tenantId,
        });
        setRowError(SETTINGS_STRINGS.peopleStatusUpdateError);
      });
  }

  function handleRemove(principal: Principal) {
    if (tenantId === null) return;
    setRowError(null);
    removePrincipal(tenantId, principal.id)
      .then(reload)
      .catch((cause: unknown) => {
        reportError(cause, { operation: "settings.people.remove", tenantId });
        setRowError(SETTINGS_STRINGS.peopleRemoveError);
      });
  }

  function handleRoleChange(
    principal: Principal,
    newRoleId: string,
    people: readonly Principal[],
    roles: readonly Role[],
  ) {
    if (tenantId === null) return;
    setRowError(null);
    const ownerRole = findSystemRole(roles, "owner");
    const currentRoleIds = new Set(principal.roles.map((r) => r.id));
    if (currentRoleIds.has(newRoleId)) return;

    if (
      ownerRole !== undefined &&
      currentRoleIds.has(ownerRole.id) &&
      newRoleId !== ownerRole.id &&
      countHoldingRole(people, ownerRole.id) <= 1
    ) {
      setRowError(SETTINGS_STRINGS.peopleLastOwnerError);
      return;
    }

    const toUnassign = principal.roles.filter((r) =>
      roles.some((role) => role.id === r.id),
    );
    Promise.all(
      toUnassign.map((r) => unassignRole(tenantId, principal.id, r.id)),
    )
      .then(() => assignRole(tenantId, principal.id, newRoleId))
      .then(reload)
      .catch((cause: unknown) => {
        reportError(cause, {
          operation: "settings.people.changeRole",
          tenantId,
        });
        setRowError(SETTINGS_STRINGS.peopleRoleChangeError);
      });
  }

  return (
    <QueryView query={query} label={SETTINGS_STRINGS.peopleLoadError}>
      {({ people, roles }) => (
        <SettingsPanel
          title={SETTINGS_STRINGS.peopleSectionTitle}
          description={SETTINGS_STRINGS.peopleSectionDescription}
        >
          {rowError !== null && (
            <p className="settings-inline-error" role="alert">
              {rowError}
            </p>
          )}
          <PeopleTable
            people={people}
            roles={roles}
            onSuspend={(p) => handleStatusChange(p, "suspended")}
            onReactivate={(p) => handleStatusChange(p, "active")}
            onRemove={handleRemove}
            onRoleChange={(p, roleId) =>
              handleRoleChange(p, roleId, people, roles)
            }
          />
          <AccessPolicyBlock tenantId={tenantId} />
        </SettingsPanel>
      )}
    </QueryView>
  );
}

function countHoldingRole(
  people: readonly Principal[],
  roleId: string,
): number {
  return people.filter((p) => p.roles.some((r) => r.id === roleId)).length;
}

export function PeopleTable({
  people,
  roles,
  onSuspend,
  onReactivate,
  onRemove,
  onRoleChange,
}: {
  readonly people: readonly Principal[];
  readonly roles: readonly Role[];
  readonly onSuspend: (principal: Principal) => void;
  readonly onReactivate: (principal: Principal) => void;
  readonly onRemove: (principal: Principal) => void;
  readonly onRoleChange: (principal: Principal, roleId: string) => void;
}) {
  const ownerRole = findSystemRole(roles, "owner");
  const memberRole = findSystemRole(roles, "member");

  if (people.length === 0) {
    return (
      <EmptyState
        title={SETTINGS_STRINGS.peopleEmptyTitle}
        description={SETTINGS_STRINGS.peopleEmptyDescription}
      />
    );
  }
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Name</TableHead>
          <TableHead>Kind</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Roles</TableHead>
          <TableHead className="settings-actions-cell">Actions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {people.map((person) => {
          const identity = principalLabel(person.displayName);
          const selectableRoles = [ownerRole, memberRole].filter(
            (r): r is Role => r !== undefined,
          );
          const currentRoleId =
            person.roles.find((r) =>
              selectableRoles.some((role) => role.id === r.id),
            )?.id ?? memberRole?.id;

          return (
            <TableRow key={person.id}>
              <TableCell>
                <span title={identity.raw ?? undefined}>{identity.label}</span>
                {person.email !== undefined ? (
                  <span className="settings-member-email"> {person.email}</span>
                ) : null}
              </TableCell>
              <TableCell>{PRINCIPAL_KIND_LABEL[person.kind]}</TableCell>
              <TableCell>
                <Badge tone={STATUS_TONE[person.status]}>{person.status}</Badge>
              </TableCell>
              <TableCell>
                {selectableRoles.length === 2 ? (
                  <select
                    className="settings-select"
                    aria-label={`${SETTINGS_STRINGS.peopleInviteRoleLabel} — ${identity.label}`}
                    value={currentRoleId}
                    onChange={(event) =>
                      onRoleChange(person, event.target.value)
                    }
                  >
                    {selectableRoles.map((role) => (
                      <option key={role.id} value={role.id}>
                        {role.name.toLowerCase() === "owner"
                          ? SETTINGS_STRINGS.peopleInviteRoleOwner
                          : SETTINGS_STRINGS.peopleInviteRoleMember}
                      </option>
                    ))}
                  </select>
                ) : person.roles.length === 0 ? (
                  SETTINGS_STRINGS.peopleRoleNone
                ) : (
                  person.roles.map((role) => (
                    <Badge key={role.id} tone="neutral">
                      {role.name}
                    </Badge>
                  ))
                )}
              </TableCell>
              <TableCell className="settings-actions-cell">
                <div className="settings-row-actions">
                  {person.status === "suspended" ? (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => onReactivate(person)}
                    >
                      {SETTINGS_STRINGS.peopleReactivate}
                    </Button>
                  ) : (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => onSuspend(person)}
                    >
                      {SETTINGS_STRINGS.peopleSuspend}
                    </Button>
                  )}
                  <ConfirmButton
                    variant="destructive"
                    size="sm"
                    confirmLabel={SETTINGS_STRINGS.peopleRemoveConfirm}
                    onConfirm={() => onRemove(person)}
                  >
                    {SETTINGS_STRINGS.peopleRemove}
                  </ConfirmButton>
                </div>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
