// The "People" settings section: every human (`kind: "user"`) principal on
// this bench, with invite/suspend/reactivate/remove actions over the native
// `/api/tenants/:tenantId/principals` and `/members/invite` routes. Agent
// and workflow principals are machine identities, not people to manage
// here — Roles/Grants sections list every kind since those assign to
// machines too. Never renders a raw principal id or a raw agent refId — see
// `identity.ts`.

import {
  Badge,
  Button,
  ConfirmButton,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  EmptyState,
  Input,
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
import { PRINCIPAL_KIND_LABEL, principalLabel } from "./identity";
import { AccessPolicyBlock } from "./access-policy";

import { SETTINGS_STRINGS } from "./strings";
import {
  TenancyApiError,
  invitePrincipal,
  listPrincipals,
  removePrincipal,
  updatePrincipalStatus,
  type Principal,
} from "./tenancy-api";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const STATUS_TONE: Record<Principal["status"], "success" | "info" | "neutral"> =
  {
    active: "success",
    invited: "info",
    suspended: "neutral",
    deactivated: "neutral",
  };

export function PeopleSection({
  tenantId,
}: {
  readonly tenantId: string | null;
}) {
  const [query, setQuery] = useState<APIQuery<readonly Principal[]>>({
    kind: "loading",
  });
  const [reloadKey, setReloadKey] = useState(0);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviting, setInviting] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);

  function reload() {
    setReloadKey((value) => value + 1);
  }

  useEffect(() => {
    if (tenantId === null) return;
    let cancelled = false;
    setQuery({ kind: "loading" });
    listPrincipals(tenantId)
      .then((principals) => {
        if (!cancelled)
          setQuery({
            kind: "ready",
            data: principals.filter((p) => p.kind === "user"),
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

  function handleInvite(email: string) {
    if (tenantId === null) return;
    setInviting(true);
    setInviteError(null);
    invitePrincipal(tenantId, email)
      .then(() => {
        setInviteOpen(false);
        reload();
      })
      .catch((cause: unknown) => {
        setInviteError(
          cause instanceof TenancyApiError && cause.status === 404
            ? SETTINGS_STRINGS.peopleInviteNotFoundError
            : SETTINGS_STRINGS.peopleInviteError,
        );
      })
      .finally(() => setInviting(false));
  }

  function handleStatusChange(
    principal: Principal,
    status: "active" | "suspended",
  ) {
    if (tenantId === null) return;
    setRowError(null);
    updatePrincipalStatus(tenantId, principal.id, status)
      .then(reload)
      .catch(() => setRowError(SETTINGS_STRINGS.peopleStatusUpdateError));
  }

  function handleRemove(principal: Principal) {
    if (tenantId === null) return;
    setRowError(null);
    removePrincipal(tenantId, principal.id)
      .then(reload)
      .catch(() => setRowError(SETTINGS_STRINGS.peopleRemoveError));
  }

  return (
    <QueryView query={query} label={SETTINGS_STRINGS.peopleLoadError}>
      {(people) => (
        <SettingsPanel
          title={SETTINGS_STRINGS.peopleSectionTitle}
          description={SETTINGS_STRINGS.peopleSectionDescription}
        >
          <div className="settings-section-toolbar">
            <Button variant="primary" onClick={() => setInviteOpen(true)}>
              {SETTINGS_STRINGS.peopleInviteAction}
            </Button>
          </div>
          {rowError !== null && (
            <p className="settings-inline-error" role="alert">
              {rowError}
            </p>
          )}
          <PeopleTable
            people={people}
            onSuspend={(p) => handleStatusChange(p, "suspended")}
            onReactivate={(p) => handleStatusChange(p, "active")}
            onRemove={handleRemove}
          />
          <AccessPolicyBlock tenantId={tenantId} />
          <InvitePersonDialog
            open={inviteOpen}
            onOpenChange={setInviteOpen}
            onInvite={handleInvite}
            submitting={inviting}
            error={inviteError}
          />
        </SettingsPanel>
      )}
    </QueryView>
  );
}

export function PeopleTable({
  people,
  onSuspend,
  onReactivate,
  onRemove,
}: {
  readonly people: readonly Principal[];
  readonly onSuspend: (principal: Principal) => void;
  readonly onReactivate: (principal: Principal) => void;
  readonly onRemove: (principal: Principal) => void;
}) {
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
          <TableHead>Actions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {people.map((person) => {
          const identity = principalLabel(person.displayName);
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
                {person.roles.length === 0
                  ? SETTINGS_STRINGS.peopleRoleNone
                  : person.roles.map((role) => (
                      <Badge key={role.id} tone="neutral">
                        {role.name}
                      </Badge>
                    ))}
              </TableCell>
              <TableCell>
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

export function InvitePersonDialog({
  open,
  onOpenChange,
  onInvite,
  submitting,
  error = null,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onInvite: (email: string) => void;
  readonly submitting: boolean;
  readonly error?: string | null;
}) {
  const [email, setEmail] = useState("");
  const canSubmit = EMAIL_PATTERN.test(email.trim());

  function reset() {
    setEmail("");
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) reset();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{SETTINGS_STRINGS.peopleInviteDialogTitle}</DialogTitle>
          <DialogDescription>
            {SETTINGS_STRINGS.peopleInviteDialogDescription}
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <form
            id="invite-person-form"
            className="settings-form-field"
            onSubmit={(event) => {
              event.preventDefault();
              if (canSubmit) onInvite(email.trim());
            }}
          >
            <label className="settings-form-field">
              <span>{SETTINGS_STRINGS.peopleInviteEmailLabel}</span>
              <Input
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder={SETTINGS_STRINGS.peopleInviteEmailPlaceholder}
                autoFocus
              />
            </label>
            {error !== null && (
              <p className="settings-inline-error" role="alert">
                {error}
              </p>
            )}
          </form>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {SETTINGS_STRINGS.peopleInviteCancel}
          </Button>
          <Button
            type="submit"
            form="invite-person-form"
            variant="primary"
            disabled={!canSubmit || submitting}
          >
            {submitting
              ? SETTINGS_STRINGS.peopleInviteInviting
              : SETTINGS_STRINGS.peopleInviteSubmit}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
