// "Apply a profile" — the workbench Inference section's affordance for
// attaching a workspace-level config profile in one action. A profile is
// a MACRO: choosing one previews the exact `PATCH` writes `POST /apply`
// is about to issue (`planApply`'s own plan, read-only until Apply is
// pressed) — never a second, speculative preview computation of its own.
import { Button, EmptyState, Skeleton, toast } from "@corbits/react-ui";
import { useEffect, useState } from "react";

import {
  applyProfile,
  ConfigProfilesApiError,
  listProfiles,
  type ApplyProfileResponse,
  type ConfigProfile,
} from "./api";

type LoadState =
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "ready"; readonly profiles: readonly ConfigProfile[] };

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof ConfigProfilesApiError ? cause.message : fallback;
}

/** A one-line, plain-language preview of what Apply is about to do —
 * counts, never a full row-by-row dump, so the affordance stays a single
 * line next to the Apply button. */
function previewSentence(profile: ConfigProfile): string {
  const count = profile.entries.length;
  const noun = count === 1 ? "provider" : "providers";
  return `Sets this workbench's fallback order to ${profile.name}'s ${String(count)} ${noun}.`;
}

export function ApplyProfilePanel({
  tenantId,
}: {
  /** The workbench this panel applies a profile to — also the tenant its
   * own profiles are listed and applied from, in today's one-tenant
   * account/workbench shape. */
  readonly tenantId: string;
}) {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [selectedId, setSelectedId] = useState<string>("");
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ApplyProfileResponse | null>(null);

  useEffect(() => {
    setState({ kind: "loading" });
    listProfiles(tenantId)
      .then((profiles) => setState({ kind: "ready", profiles }))
      .catch((cause: unknown) =>
        setState({
          kind: "error",
          message: errorMessage(cause, "Couldn't load profiles."),
        }),
      );
  }, [tenantId]);

  if (state.kind === "loading") return <Skeleton className="query-skeleton" />;
  if (state.kind === "error") {
    return (
      <EmptyState title="Couldn't load profiles" description={state.message} />
    );
  }
  if (state.profiles.length === 0) {
    return (
      <EmptyState
        title="No profiles yet"
        description="Create a profile from Settings to apply it here in one action."
      />
    );
  }

  const selected = state.profiles.find((profile) => profile.id === selectedId);

  function handleApply() {
    if (selected === undefined) return;
    setApplying(true);
    setError(null);
    setResult(null);
    applyProfile(tenantId, {
      profileId: selected.id,
      workbenchTenantId: tenantId,
    })
      .then((applied) => {
        setResult(applied);
        toast(`Applied ${applied.profileName}.`);
      })
      .catch((cause: unknown) =>
        setError(errorMessage(cause, "Couldn't apply that profile.")),
      )
      .finally(() => setApplying(false));
  }

  return (
    <div className="chat-settings-callout">
      <strong>Apply a profile</strong>
      <p className="chat-settings-field-hint">
        Attaching a profile sets this workbench's fallback order to match it in
        one action. Reordering or restricting a provider afterward always wins
        over what the profile set.
      </p>
      <div className="settings-form-field">
        <select
          className="settings-select"
          value={selectedId}
          onChange={(event) => {
            setSelectedId(event.target.value);
            setResult(null);
            setError(null);
          }}
        >
          <option value="">Choose a profile…</option>
          {state.profiles.map((profile) => (
            <option key={profile.id} value={profile.id}>
              {profile.name}
            </option>
          ))}
        </select>
        {selected !== undefined ? (
          <p className="chat-settings-field-hint">
            {previewSentence(selected)}
          </p>
        ) : null}
      </div>
      {error !== null ? (
        <p className="chat-dialog-error" role="alert">
          {error}
        </p>
      ) : null}
      {result !== null ? (
        <p className="chat-settings-field-hint" role="status">
          {result.results.filter((r) => r.action === "reordered").length} set,{" "}
          {
            result.results.filter((r) => r.action === "skipped-inherited")
              .length
          }{" "}
          need a key first,{" "}
          {
            result.results.filter((r) => r.action === "skipped-unavailable")
              .length
          }{" "}
          not available here.
        </p>
      ) : null}
      <Button
        variant="primary"
        disabled={selected === undefined || applying}
        onClick={handleApply}
      >
        {applying ? "Applying…" : "Apply"}
      </Button>
    </div>
  );
}
