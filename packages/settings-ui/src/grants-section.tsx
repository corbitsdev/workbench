// The "Grants" settings section: what each role or person is allowed,
// denied, or asked about, and on what — filterable, creatable, revocable
// over the native `/api/tenants/:tenantId/grants` route. The resource
// vocabulary has no listing endpoint of its own (see the tenancy
// inventory's gap list); `resource-vocabulary.ts` carries it as a constant.

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
  FilterBar,
  SettingsPanel,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  toast,
} from "@corbits/react-ui";
import { grantEffects, grantOrigins } from "@intx/types";
import type { GrantEffect, GrantOrigin } from "@intx/types";
import { useEffect, useMemo, useState } from "react";

import type { APIQuery } from "@corbits/api-query";
import {
  QueryView,
  UnauthenticatedError,
  describeQueryError,
} from "@corbits/api-query";
import {
  PRINCIPAL_KIND_LABEL,
  PRINCIPAL_KIND_ORDER,
  principalLabel,
} from "./identity";
import {
  expiryIsoFromPreset,
  expiryLabelFromPreset,
  grantPreviewSentence,
} from "./grant-preview";
import { KindCards } from "./kind-cards";
import {
  GRANT_ACTIONS,
  GRANT_RESOURCES,
  GRANT_RESOURCE_LABEL,
  type GrantResource,
} from "./resource-vocabulary";
import { SETTINGS_STRINGS } from "./strings";
import {
  createGrant,
  listGrants,
  listPrincipals,
  listRoles,
  revokeGrant,
  type Grant,
  type GrantFilters,
  type Principal,
  type Role,
} from "./tenancy-api";

const EFFECT_TONE: Record<GrantEffect, "success" | "danger" | "info"> = {
  allow: "success",
  deny: "danger",
  ask: "info",
};

const EFFECT_LABEL: Record<GrantEffect, string> = {
  allow: "Can",
  deny: "Can't",
  ask: "Ask first",
};

function resourceLabel(resource: string): string {
  return GRANT_RESOURCE_LABEL[resource as GrantResource] ?? resource;
}

/** "Alice Anderson — person": a picker that can't group by kind (a native
 * `FilterBar`'s flat option list) still names the kind, so a workflow's
 * machine principal never reads as indistinguishable from a person. */
function principalFilterLabel(principal: Principal): string {
  return `${principalLabel(principal.displayName).label} — ${PRINCIPAL_KIND_LABEL[principal.kind]}`;
}

type GrantsData = {
  readonly grants: readonly Grant[];
  readonly roles: readonly Role[];
  readonly principals: readonly Principal[];
};

export function GrantsSection({
  tenantId,
}: {
  readonly tenantId: string | null;
}) {
  const [filters, setFilters] = useState<GrantFilters>({});
  const [query, setQuery] = useState<APIQuery<GrantsData>>({
    kind: "loading",
  });
  const [reloadKey, setReloadKey] = useState(0);
  const [createOpen, setCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);
  const filtersKey = JSON.stringify(filters);

  function reload() {
    setReloadKey((value) => value + 1);
  }

  useEffect(() => {
    if (tenantId === null) return;
    let cancelled = false;
    setQuery({ kind: "loading" });
    Promise.all([
      listGrants(tenantId, filters),
      listRoles(tenantId),
      listPrincipals(tenantId),
    ])
      .then(([grants, roles, principals]) => {
        if (!cancelled)
          setQuery({ kind: "ready", data: { grants, roles, principals } });
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
  }, [tenantId, reloadKey, filtersKey]);

  if (tenantId === null) {
    return (
      <EmptyState
        title={SETTINGS_STRINGS.benchNoneSelectedTitle}
        description={SETTINGS_STRINGS.benchNoneSelectedDescription}
      />
    );
  }

  function handleCreate(input: {
    readonly targetType: "role" | "principal";
    readonly targetId: string;
    readonly resource: string;
    readonly action: string;
    readonly effect: GrantEffect;
    readonly origin: GrantOrigin;
    readonly expiresAt: string | null;
  }) {
    if (tenantId === null) return;
    setCreating(true);
    setCreateError(null);
    const shared = {
      resource: input.resource,
      action: input.action,
      effect: input.effect,
      origin: input.origin,
    };
    const target =
      input.targetType === "role"
        ? { ...shared, roleId: input.targetId }
        : { ...shared, principalId: input.targetId };
    createGrant(
      tenantId,
      input.expiresAt !== null
        ? { ...target, expiresAt: input.expiresAt }
        : target,
    )
      .then(() => {
        setCreateOpen(false);
        reload();
        toast(SETTINGS_STRINGS.grantCreatedToast);
      })
      .catch(() => setCreateError(SETTINGS_STRINGS.grantsCreateError))
      .finally(() => setCreating(false));
  }

  function handleRevoke(grant: Grant) {
    if (tenantId === null) return;
    setRowError(null);
    revokeGrant(tenantId, grant.id)
      .then(() => {
        reload();
        toast(SETTINGS_STRINGS.grantRevokedToast);
      })
      .catch(() => setRowError(SETTINGS_STRINGS.grantsRevokeError));
  }

  return (
    <QueryView query={query} label={SETTINGS_STRINGS.grantsLoadError}>
      {({ grants, roles, principals }) => (
        <SettingsPanel
          title={SETTINGS_STRINGS.grantsSectionTitle}
          description={SETTINGS_STRINGS.grantsSectionDescription}
        >
          <GrantsFilterBar
            filters={filters}
            roles={roles}
            principals={principals}
            onChange={setFilters}
          />
          <div className="settings-section-toolbar">
            <Button variant="primary" onClick={() => setCreateOpen(true)}>
              {SETTINGS_STRINGS.grantsCreateAction}
            </Button>
          </div>
          {rowError !== null && (
            <p className="settings-inline-error" role="alert">
              {rowError}
            </p>
          )}
          <GrantsTable grants={grants} onRevoke={handleRevoke} />
          <CreateGrantDialog
            open={createOpen}
            onOpenChange={setCreateOpen}
            roles={roles}
            principals={principals}
            onCreate={handleCreate}
            submitting={creating}
            error={createError}
          />
        </SettingsPanel>
      )}
    </QueryView>
  );
}

function GrantsFilterBar({
  filters,
  roles,
  principals,
  onChange,
}: {
  readonly filters: GrantFilters;
  readonly roles: readonly Role[];
  readonly principals: readonly Principal[];
  readonly onChange: (filters: GrantFilters) => void;
}) {
  return (
    <FilterBar
      filters={[
        {
          id: "principalId",
          label: SETTINGS_STRINGS.grantsFilterPrincipal,
          anyLabel: SETTINGS_STRINGS.grantsFilterAny,
          value: filters.principalId ?? null,
          options: principals.map((principal) => ({
            value: principal.id,
            label: principalFilterLabel(principal),
          })),
        },
        {
          id: "roleId",
          label: SETTINGS_STRINGS.grantsFilterRole,
          anyLabel: SETTINGS_STRINGS.grantsFilterAny,
          value: filters.roleId ?? null,
          options: roles.map((role) => ({ value: role.id, label: role.name })),
        },
        {
          id: "resource",
          label: SETTINGS_STRINGS.grantsFilterResource,
          anyLabel: SETTINGS_STRINGS.grantsFilterAny,
          value: filters.resource ?? null,
          options: GRANT_RESOURCES.map((resource) => ({
            value: resource,
            label: resourceLabel(resource),
          })),
        },
        {
          id: "effect",
          label: SETTINGS_STRINGS.grantsFilterEffect,
          anyLabel: SETTINGS_STRINGS.grantsFilterAny,
          value: filters.effect ?? null,
          options: grantEffects.map((effect) => ({
            value: effect,
            label: effect,
          })),
        },
      ]}
      onChange={(id, value) => {
        const { [id as keyof GrantFilters]: _removed, ...rest } = filters;
        const next: GrantFilters =
          value === null ? rest : ({ ...rest, [id]: value } as GrantFilters);
        onChange(next);
      }}
    />
  );
}

export function GrantsTable({
  grants,
  onRevoke,
}: {
  readonly grants: readonly Grant[];
  readonly onRevoke: (grant: Grant) => void;
}) {
  if (grants.length === 0) {
    return (
      <EmptyState
        title={SETTINGS_STRINGS.grantsEmptyTitle}
        description={SETTINGS_STRINGS.grantsEmptyDescription}
      />
    );
  }
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Applies to</TableHead>
          <TableHead>Resource</TableHead>
          <TableHead>Action</TableHead>
          <TableHead>Effect</TableHead>
          <TableHead>Origin</TableHead>
          <TableHead>Expires</TableHead>
          <TableHead>Actions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {grants.map((grant) => (
          <TableRow key={grant.id}>
            <TableCell>
              {grant.roleName ?? grant.principalName ?? "—"}
            </TableCell>
            <TableCell>
              <span title={grant.resource}>
                {resourceLabel(grant.resource)}
              </span>
            </TableCell>
            <TableCell>{grant.action}</TableCell>
            <TableCell>
              <Badge tone={EFFECT_TONE[grant.effect]}>
                {EFFECT_LABEL[grant.effect]}
              </Badge>
            </TableCell>
            <TableCell>{grant.origin}</TableCell>
            <TableCell>
              {grant.expiresAt ?? SETTINGS_STRINGS.grantsNoExpiry}
            </TableCell>
            <TableCell>
              <ConfirmButton
                variant="destructive"
                size="sm"
                confirmLabel={SETTINGS_STRINGS.grantsRevokeConfirm}
                onConfirm={() => onRevoke(grant)}
              >
                {SETTINGS_STRINGS.grantsRevoke}
              </ConfirmButton>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export function CreateGrantDialog({
  open,
  onOpenChange,
  roles,
  principals,
  onCreate,
  submitting,
  error = null,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly roles: readonly Role[];
  readonly principals: readonly Principal[];
  readonly onCreate: (input: {
    readonly targetType: "role" | "principal";
    readonly targetId: string;
    readonly resource: string;
    readonly action: string;
    readonly effect: GrantEffect;
    readonly origin: GrantOrigin;
    readonly expiresAt: string | null;
  }) => void;
  readonly submitting: boolean;
  readonly error?: string | null;
}) {
  const [targetType, setTargetType] = useState<"role" | "principal">("role");
  const [targetId, setTargetId] = useState("");
  const [resource, setResource] = useState<string>(GRANT_RESOURCES[0]);
  const [action, setAction] = useState<string>(GRANT_ACTIONS[0]);
  // Default to Require approval (ask) — the safer first choice for new grants.
  const [effect, setEffect] = useState<GrantEffect>("ask");
  const [origin, setOrigin] = useState<GrantOrigin>("role");
  const [expiryPreset, setExpiryPreset] = useState<
    "never" | "24h" | "7d" | "30d"
  >("never");

  const targetOptions = useMemo(
    () =>
      targetType === "role"
        ? roles.map((role) => ({
            id: role.id,
            label: role.name,
            kind: undefined,
          }))
        : principals.map((principal) => ({
            id: principal.id,
            label: principalLabel(principal.displayName).label,
            kind: principal.kind,
          })),
    [targetType, roles, principals],
  );

  const targetLabel =
    targetOptions.find((option) => option.id === targetId)?.label ?? null;
  const preview = grantPreviewSentence({
    targetLabel,
    resource: resourceLabel(resource),
    action,
    effect,
    expiresLabel: expiryLabelFromPreset(expiryPreset),
  });

  const canSubmit = targetId.length > 0;

  function reset() {
    setTargetType("role");
    setTargetId("");
    setResource(GRANT_RESOURCES[0]);
    setAction(GRANT_ACTIONS[0]);
    setEffect("ask");
    setOrigin("role");
    setExpiryPreset("never");
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
          <DialogTitle>{SETTINGS_STRINGS.grantsCreateDialogTitle}</DialogTitle>
          <DialogDescription>
            {SETTINGS_STRINGS.grantsCreateDialogDescription}
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <form
            id="create-grant-form"
            className="settings-form-field"
            onSubmit={(event) => {
              event.preventDefault();
              if (canSubmit) {
                onCreate({
                  targetType,
                  targetId,
                  resource,
                  action,
                  effect,
                  origin,
                  expiresAt: expiryIsoFromPreset(expiryPreset),
                });
              }
            }}
          >
            <div className="settings-form-field">
              <span>{SETTINGS_STRINGS.grantsTargetTypeLabel}</span>
              <KindCards
                label={SETTINGS_STRINGS.grantsTargetTypeLabel}
                columns={2}
                value={targetType}
                onChange={(id) => {
                  setTargetType(id as "role" | "principal");
                  setTargetId("");
                }}
                options={[
                  {
                    id: "role",
                    title: SETTINGS_STRINGS.grantsTargetTypeRole,
                    description:
                      SETTINGS_STRINGS.grantsTargetTypeRoleDescription,
                  },
                  {
                    id: "principal",
                    title: SETTINGS_STRINGS.grantsTargetTypePrincipal,
                    description:
                      SETTINGS_STRINGS.grantsTargetTypePrincipalDescription,
                  },
                ]}
              />
            </div>
            <label className="settings-form-field">
              <span>{SETTINGS_STRINGS.grantsTargetLabel}</span>
              <select
                className="settings-select"
                value={targetId}
                onChange={(event) => setTargetId(event.target.value)}
                autoFocus
              >
                <option value="">—</option>
                {targetType === "role"
                  ? targetOptions.map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.label}
                      </option>
                    ))
                  : PRINCIPAL_KIND_ORDER.map((kind) => {
                      const kindOptions = targetOptions.filter(
                        (option) => option.kind === kind,
                      );
                      if (kindOptions.length === 0) return null;
                      return (
                        <optgroup key={kind} label={PRINCIPAL_KIND_LABEL[kind]}>
                          {kindOptions.map((option) => (
                            <option key={option.id} value={option.id}>
                              {option.label}
                            </option>
                          ))}
                        </optgroup>
                      );
                    })}
              </select>
            </label>
            <div className="settings-form-field">
              <span>{SETTINGS_STRINGS.grantsResourceLabel}</span>
              <KindCards
                label={SETTINGS_STRINGS.grantsResourceLabel}
                columns={3}
                value={resource}
                onChange={setResource}
                options={GRANT_RESOURCES.map((value) => ({
                  id: value,
                  title: GRANT_RESOURCE_LABEL[value],
                  description: value,
                }))}
              />
            </div>
            <label className="settings-form-field">
              <span>{SETTINGS_STRINGS.grantsActionLabel}</span>
              <select
                className="settings-select"
                value={action}
                onChange={(event) => setAction(event.target.value)}
              >
                {GRANT_ACTIONS.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </label>
            <div className="settings-form-field">
              <span>{SETTINGS_STRINGS.grantsEffectLabel}</span>
              <KindCards
                label={SETTINGS_STRINGS.grantsEffectLabel}
                columns={3}
                value={effect}
                onChange={(id) => setEffect(id as GrantEffect)}
                options={[
                  {
                    id: "ask",
                    title: "Ask first",
                    description: "Ask a human before the action runs.",
                  },
                  {
                    id: "allow",
                    title: "Can",
                    description: "Permit without further checks.",
                  },
                  {
                    id: "deny",
                    title: "Can't",
                    description: "Block the action outright.",
                  },
                ]}
              />
            </div>
            <label className="settings-form-field">
              <span>{SETTINGS_STRINGS.grantsOriginLabel}</span>
              <select
                className="settings-select"
                value={origin}
                onChange={(event) =>
                  setOrigin(event.target.value as GrantOrigin)
                }
              >
                {grantOrigins.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </label>
            <div className="settings-form-field">
              <span>{SETTINGS_STRINGS.grantsExpiresLabel}</span>
              <KindCards
                label={SETTINGS_STRINGS.grantsExpiresLabel}
                columns={2}
                value={expiryPreset}
                onChange={(id) =>
                  setExpiryPreset(id as "never" | "24h" | "7d" | "30d")
                }
                options={[
                  { id: "never", title: "Never", description: "No expiry." },
                  { id: "24h", title: "24 hours" },
                  { id: "7d", title: "7 days" },
                  { id: "30d", title: "30 days" },
                ]}
              />
            </div>
            <p className="settings-grant-preview" data-testid="grant-preview">
              {preview}
            </p>
            {error !== null && (
              <p className="settings-inline-error" role="alert">
                {error}
              </p>
            )}
          </form>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {SETTINGS_STRINGS.grantsCreateCancel}
          </Button>
          <Button
            type="submit"
            form="create-grant-form"
            variant="primary"
            disabled={!canSubmit || submitting}
          >
            {SETTINGS_STRINGS.grantsCreateSubmit}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
