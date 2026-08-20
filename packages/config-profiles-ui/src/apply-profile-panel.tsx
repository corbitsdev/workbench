// "Apply a profile" — the workbench Inference section's affordance for
// attaching a workspace-level config profile in one action. A profile is
// a MACRO: choosing one fetches `POST /:id/plan`'s read-only dry run — the
// exact same `planApply` decision `POST /apply` will act on — and renders
// it per entry, in plain language, before a person ever presses Apply.
// After Apply, the same per-entry rendering shows what actually happened
// (including a partial failure's successes, failure, and anything never
// attempted), never a bare aggregate count.
import { Button, toast } from "@corbits/react-ui";
import { useEffect, useState } from "react";

import type { APIQuery } from "@corbits/api-query";
import {
  QueryView,
  UnauthenticatedError,
  describeQueryError,
} from "@corbits/api-query";
import {
  applyProfile,
  ConfigProfilesApiError,
  listProfiles,
  planProfile,
  type ApplyEntryResult,
  type ConfigProfile,
} from "./api";
import { CONFIG_PROFILES_STRINGS } from "./strings";

type PlanState =
  | { readonly kind: "idle" }
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "ready"; readonly results: readonly ApplyEntryResult[] };

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof ConfigProfilesApiError ? cause.message : fallback;
}

function EntryList({
  results,
  tense,
}: {
  readonly results: readonly ApplyEntryResult[];
  readonly tense: "future" | "past";
}) {
  return (
    <ul className="config-profiles-entry-list">
      {results.map((entry, index) => (
        <li key={index} className="config-profiles-entry-line">
          {CONFIG_PROFILES_STRINGS.entryLine(entry, tense)}
        </li>
      ))}
    </ul>
  );
}

export function ApplyProfilePanel({
  tenantId,
}: {
  /** The workbench this panel applies a profile to — also the tenant its
   * own profiles are listed and applied from, in today's one-tenant
   * account/workbench shape (there is no separate workbench picker on
   * this panel yet; the tenant a profile is read from and the tenant it
   * is applied to are always the same one). */
  readonly tenantId: string;
}) {
  const [query, setQuery] = useState<APIQuery<readonly ConfigProfile[]>>({
    kind: "loading",
  });
  const [selectedId, setSelectedId] = useState<string>("");
  const [plan, setPlan] = useState<PlanState>({ kind: "idle" });
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<readonly ApplyEntryResult[] | null>(
    null,
  );

  const loadProfiles = () => {
    setQuery({ kind: "loading" });
    listProfiles(tenantId)
      .then((profiles) => setQuery({ kind: "ready", data: profiles }))
      .catch((cause: unknown) => {
        if (cause instanceof UnauthenticatedError) {
          setQuery({ kind: "unauthenticated" });
          return;
        }
        setQuery({
          kind: "error",
          message: describeQueryError(cause),
          retry: loadProfiles,
        });
      });
  };

  useEffect(() => {
    loadProfiles();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId]);

  useEffect(() => {
    if (selectedId === "") {
      setPlan({ kind: "idle" });
      return;
    }
    let cancelled = false;
    setPlan({ kind: "loading" });
    planProfile(tenantId, selectedId, { targetTenantId: tenantId })
      .then((response) => {
        if (!cancelled) setPlan({ kind: "ready", results: response.results });
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setPlan({
            kind: "error",
            message: errorMessage(cause, CONFIG_PROFILES_STRINGS.planError),
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [tenantId, selectedId]);

  function handleApply(selected: ConfigProfile) {
    setApplying(true);
    setError(null);
    setResults(null);
    applyProfile(tenantId, {
      profileId: selected.id,
      targetTenantId: tenantId,
    })
      .then((applied) => {
        setResults(applied.results);
        if (applied.ok) {
          toast(CONFIG_PROFILES_STRINGS.appliedToast(applied.profileName));
        } else {
          setError(CONFIG_PROFILES_STRINGS.applyError);
        }
      })
      .catch((cause: unknown) =>
        setError(errorMessage(cause, CONFIG_PROFILES_STRINGS.applyError)),
      )
      .finally(() => setApplying(false));
  }

  return (
    <QueryView query={query} label={CONFIG_PROFILES_STRINGS.loadError}>
      {(profiles) => {
        // No profiles exist yet for this tenant to apply — nothing this
        // panel can offer, so it renders nothing rather than an empty-state
        // callout every workbench without a profile would otherwise see
        // (CL-6151: it read as a broken feature, not an unused one).
        if (profiles.length === 0) return null;
        const selected = profiles.find((profile) => profile.id === selectedId);
        return (
          <div className="config-profiles-callout">
            <strong>{CONFIG_PROFILES_STRINGS.applyPanelTitle}</strong>
            <p>{CONFIG_PROFILES_STRINGS.applyPanelDescription}</p>
            <div className="config-profiles-field">
              <select
                className="config-profiles-select"
                value={selectedId}
                onChange={(event) => {
                  setSelectedId(event.target.value);
                  setResults(null);
                  setError(null);
                }}
              >
                <option value="">
                  {CONFIG_PROFILES_STRINGS.chooseProfilePlaceholder}
                </option>
                {profiles.map((profile) => (
                  <option key={profile.id} value={profile.id}>
                    {profile.name}
                  </option>
                ))}
              </select>
              {selected !== undefined && plan.kind === "loading" ? (
                <p className="config-profiles-field-hint">
                  {CONFIG_PROFILES_STRINGS.planLoadingLabel}
                </p>
              ) : null}
              {selected !== undefined && plan.kind === "error" ? (
                <p className="config-profiles-error" role="alert">
                  {plan.message}
                </p>
              ) : null}
              {selected !== undefined &&
              plan.kind === "ready" &&
              results === null ? (
                <EntryList results={plan.results} tense="future" />
              ) : null}
            </div>
            {error !== null ? (
              <p className="config-profiles-error" role="alert">
                {error}
              </p>
            ) : null}
            {results !== null ? (
              <div role="status">
                <EntryList results={results} tense="past" />
              </div>
            ) : null}
            <Button
              variant="primary"
              disabled={selected === undefined || applying}
              onClick={() => selected !== undefined && handleApply(selected)}
            >
              {applying
                ? CONFIG_PROFILES_STRINGS.applyingButton
                : CONFIG_PROFILES_STRINGS.applyButton}
            </Button>
          </div>
        );
      }}
    </QueryView>
  );
}
