// The "Bench" settings section: the current bench's name and address, plus
// its member list (member management itself is `@corbits/bench-ui`'s to own
// — this section mounts its `MembersPanel`, never re-implements it).
// Renaming goes through the native `PATCH /api/tenants/:tenantId` route;
// there is no native route for changing a bench's slug, so the address
// stays read-only.

import type { BenchMembership } from "@corbits/bench-ui";
import { listMyMemberships, MembersPanel } from "@corbits/bench-ui";
import { EmptyState, Input, SettingsPanel, Skeleton } from "@corbits/react-ui";
import { CircleAlert } from "lucide-react";
import { useEffect, useState } from "react";

import { renameBench } from "./api";
import { errorMessage, type LoadState } from "./load-state";
import { SETTINGS_STRINGS } from "./strings";

export function BenchSection({
  tenantId,
}: {
  readonly tenantId: string | null;
}) {
  const [state, setState] = useState<LoadState<BenchMembership>>({
    kind: "loading",
  });
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);

  useEffect(() => {
    if (tenantId === null) return;
    let cancelled = false;
    setState({ kind: "loading" });
    listMyMemberships()
      .then((memberships) => {
        if (cancelled) return;
        const current = memberships.find((m) => m.tenantId === tenantId);
        if (current === undefined) {
          setState({
            kind: "error",
            message: "This bench is no longer one you belong to.",
          });
          return;
        }
        setName(current.tenantName);
        setState({ kind: "ready", data: current });
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setState({ kind: "error", message: errorMessage(cause) });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [tenantId]);

  if (tenantId === null) {
    return (
      <EmptyState
        title={SETTINGS_STRINGS.benchNoneSelectedTitle}
        description={SETTINGS_STRINGS.benchNoneSelectedDescription}
      />
    );
  }

  if (state.kind === "loading") return <Skeleton className="query-skeleton" />;
  if (state.kind === "error") {
    return (
      <EmptyState
        icon={<CircleAlert />}
        title={`Couldn't load ${SETTINGS_STRINGS.benchLoadError}`}
        description={state.message}
      />
    );
  }

  const dirty = name.trim().length > 0 && name.trim() !== state.data.tenantName;

  function handleSave() {
    const trimmed = name.trim();
    if (trimmed.length === 0) return;
    setSaving(true);
    setSaveError(null);
    renameBench(tenantId as string, trimmed)
      .then((bench) => {
        setState((previous) =>
          previous.kind === "ready"
            ? {
                kind: "ready",
                data: { ...previous.data, tenantName: bench.name },
              }
            : previous,
        );
        setName(bench.name);
        setSavedAt(new Date().toLocaleTimeString());
      })
      .catch(() => setSaveError(SETTINGS_STRINGS.benchSaveError))
      .finally(() => setSaving(false));
  }

  return (
    <>
      <BenchSectionView
        name={name}
        slug={state.data.tenantSlug}
        dirty={dirty}
        saving={saving}
        error={saveError}
        savedAt={savedAt}
        onNameChange={setName}
        onSave={handleSave}
        onReset={() => setName(state.data.tenantName)}
      />
      <MembersPanel tenantId={tenantId} />
    </>
  );
}

/**
 * The bench form's markup on its own, taking already-resolved display
 * fields rather than fetching — kept separate from `BenchSection` so it can
 * be rendered directly in tests (including the raw-id sweep) without
 * standing up a fetch stub and an effect-flushing render loop.
 */
export function BenchSectionView({
  name,
  slug,
  dirty,
  saving,
  error,
  savedAt,
  onNameChange,
  onSave,
  onReset,
}: {
  readonly name: string;
  readonly slug: string;
  readonly dirty: boolean;
  readonly saving: boolean;
  readonly error: string | null;
  readonly savedAt: string | null;
  readonly onNameChange: (name: string) => void;
  readonly onSave: () => void;
  readonly onReset: () => void;
}) {
  return (
    <SettingsPanel
      title={SETTINGS_STRINGS.benchSectionTitle}
      description={SETTINGS_STRINGS.benchSectionDescription}
      onSave={onSave}
      dirty={dirty}
      saving={saving}
      error={error}
      savedAt={savedAt}
      onReset={onReset}
    >
      <label className="settings-form-field">
        <span>{SETTINGS_STRINGS.benchNameLabel}</span>
        <Input
          value={name}
          onChange={(event) => onNameChange(event.target.value)}
        />
      </label>
      <label className="settings-form-field">
        <span>{SETTINGS_STRINGS.benchAddressLabel}</span>
        <Input value={slug} disabled readOnly />
      </label>
    </SettingsPanel>
  );
}
