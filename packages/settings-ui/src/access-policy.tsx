// The "Who can join" block for the People section: a plain-language editor
// over `@workbench/access-policy`'s per-tenant policy row (self-signup mode,
// allowed email domains, who may create a sub-workbench here). Closed by
// default — an absent row reads exactly like an explicit "off" / "owners
// only" row; see that package's `resolveAccessPolicy`.

import { Badge, Button, EmptyState, Input, Skeleton } from "@corbits/react-ui";
import { CircleAlert, X } from "lucide-react";
import { useEffect, useState } from "react";

import { getAuthConfig } from "./api";
import {
  getAccessPolicy,
  updateAccessPolicy,
  type AccessPolicy,
} from "./access-policy-api";
import { errorMessage, type LoadState } from "./load-state";
import { SETTINGS_STRINGS } from "./strings";

export function AccessPolicyBlock({ tenantId }: { readonly tenantId: string }) {
  const [state, setState] = useState<LoadState<AccessPolicy>>({
    kind: "loading",
  });
  // Whether the operator's own env-level signup switch is still closed —
  // independent of this bench's policy row and never editable here.
  // `undefined` while loading or on a failed probe: the notice only
  // renders once this is known to be `true`, never as a false positive
  // from a still-loading state.
  const [envSignupClosed, setEnvSignupClosed] = useState<boolean | undefined>(
    undefined,
  );
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setState({ kind: "loading" });
    getAccessPolicy(tenantId)
      .then((policy) => {
        if (!cancelled) setState({ kind: "ready", data: policy });
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setState({ kind: "error", message: errorMessage(cause) });
        }
      });
    getAuthConfig()
      .then((config) => {
        if (!cancelled) setEnvSignupClosed(config.signupMode === "closed");
      })
      .catch(() => {
        // Best-effort: the notice simply stays off rather than guessing.
      });
    return () => {
      cancelled = true;
    };
  }, [tenantId]);

  if (state.kind === "loading") return <Skeleton className="query-skeleton" />;
  if (state.kind === "error") {
    return (
      <EmptyState
        icon={<CircleAlert />}
        title={`Couldn't load ${SETTINGS_STRINGS.accessPolicyLoadError}`}
        description={state.message}
      />
    );
  }

  function save(patch: Partial<AccessPolicy>) {
    setSaving(true);
    setSaveError(null);
    updateAccessPolicy(tenantId, patch)
      .then((policy) => setState({ kind: "ready", data: policy }))
      .catch(() => setSaveError(SETTINGS_STRINGS.accessPolicySaveError))
      .finally(() => setSaving(false));
  }

  return (
    <AccessPolicyEditor
      policy={state.data}
      saving={saving}
      error={saveError}
      envSignupClosed={envSignupClosed === true}
      onChange={save}
    />
  );
}

export function AccessPolicyEditor({
  policy,
  saving,
  error = null,
  envSignupClosed = false,
  onChange,
}: {
  readonly policy: AccessPolicy;
  readonly saving: boolean;
  readonly error?: string | null;
  /** True once it's known the operator's WORKBENCH_SIGNUP env switch is
   * closed — shows an inline notice when this policy would otherwise
   * allow self-signup, since that env switch still gates the
   * underlying sign-up form itself regardless of this policy. */
  readonly envSignupClosed?: boolean;
  readonly onChange: (patch: Partial<AccessPolicy>) => void;
}) {
  const [domainDraft, setDomainDraft] = useState("");

  function addDomain() {
    const domain = domainDraft.trim().toLowerCase();
    if (domain.length === 0 || policy.allowedDomains.includes(domain)) {
      setDomainDraft("");
      return;
    }
    onChange({ allowedDomains: [...policy.allowedDomains, domain] });
    setDomainDraft("");
  }

  function removeDomain(domain: string) {
    onChange({
      allowedDomains: policy.allowedDomains.filter((d) => d !== domain),
    });
  }

  return (
    <div className="settings-access-policy">
      <h3 className="settings-subhead">
        {SETTINGS_STRINGS.accessPolicyHeading}
        {saving && (
          <Badge tone="neutral"> {SETTINGS_STRINGS.accessPolicySaving}</Badge>
        )}
      </h3>

      <label className="settings-form-field">
        <span>{SETTINGS_STRINGS.accessPolicySignupLabel}</span>
        <select
          className="settings-select"
          value={policy.selfSignup}
          onChange={(event) =>
            onChange({
              selfSignup: event.target.value as AccessPolicy["selfSignup"],
            })
          }
        >
          <option value="off">{SETTINGS_STRINGS.accessPolicySignupOff}</option>
          <option value="allowed-domains">
            {SETTINGS_STRINGS.accessPolicySignupAllowedDomains}
          </option>
          <option value="open">
            {SETTINGS_STRINGS.accessPolicySignupOpenOption}
          </option>
        </select>
      </label>

      {policy.selfSignup !== "off" && envSignupClosed && (
        <p className="settings-field-hint" role="status">
          {SETTINGS_STRINGS.accessPolicyEnvOverrideNotice}
        </p>
      )}

      {policy.selfSignup === "allowed-domains" && (
        <div className="settings-form-field">
          <span>{SETTINGS_STRINGS.accessPolicyDomainsLabel}</span>
          {policy.allowedDomains.length === 0 ? (
            <p className="settings-field-hint">
              {SETTINGS_STRINGS.accessPolicyDomainsEmptyHint}
            </p>
          ) : (
            <div className="settings-chip-row">
              {policy.allowedDomains.map((domain) => (
                <span key={domain} className="settings-chip">
                  {domain}
                  <button
                    type="button"
                    aria-label={`${SETTINGS_STRINGS.accessPolicyDomainsRemove} ${domain}`}
                    onClick={() => removeDomain(domain)}
                  >
                    <X size={12} />
                  </button>
                </span>
              ))}
            </div>
          )}
          <div className="settings-inline-form">
            <Input
              value={domainDraft}
              onChange={(event) => setDomainDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  addDomain();
                }
              }}
              placeholder={SETTINGS_STRINGS.accessPolicyDomainsPlaceholder}
            />
            <Button variant="outline" size="sm" onClick={addDomain}>
              {SETTINGS_STRINGS.accessPolicyDomainsAdd}
            </Button>
          </div>
        </div>
      )}

      <label className="settings-form-field">
        <span>{SETTINGS_STRINGS.accessPolicySubCreationLabel}</span>
        <select
          className="settings-select"
          value={policy.tenancyCreation}
          onChange={(event) =>
            onChange({
              tenancyCreation: event.target
                .value as AccessPolicy["tenancyCreation"],
            })
          }
        >
          <option value="owners">
            {SETTINGS_STRINGS.accessPolicySubCreationOwners}
          </option>
          <option value="owners-admins">
            {SETTINGS_STRINGS.accessPolicySubCreationOwnersAdmins}
          </option>
          <option value="none">
            {SETTINGS_STRINGS.accessPolicySubCreationNone}
          </option>
        </select>
      </label>

      {error !== null && (
        <p className="settings-inline-error" role="alert">
          {error}
        </p>
      )}
      <p className="settings-field-hint">{SETTINGS_STRINGS.accessPolicyNote}</p>
    </div>
  );
}
