// The "This bench" settings section: name, purpose, slug, workbench icon
// preview, and the member list (member management itself is
// `@corbits/bench-ui`'s to own — this section mounts its `MembersPanel`,
// never re-implements it). Renaming goes through the native `PATCH
// /api/tenants/:tenantId` route; purpose goes through `@corbits/bench`'s own
// side-table client (re-exported from `@corbits/bench-ui`), since purpose
// isn't part of Interchange's native tenant shape — see
// `create-bench-dialog.tsx`'s header note. There is no native route for
// changing a bench's slug, so the address stays read-only. Icon color is a
// local preview until tenant branding ships.

import type { BenchMembership } from "@corbits/bench-ui";
import {
  getBenchSettings,
  listMyMemberships,
  MembersPanel,
  patchBenchSettings,
} from "@corbits/bench-ui";
import {
  EmptyState,
  Input,
  SettingsPanel,
  Skeleton,
  toast,
} from "@corbits/react-ui";
import { CircleAlert } from "lucide-react";
import { useEffect, useState } from "react";

import { renameBench } from "./api";
import { errorMessage, type LoadState } from "./load-state";
import { SETTINGS_STRINGS } from "./strings";

const ICON_SWATCHES = [
  "#e98428",
  "#4a7ab5",
  "#3f8f5f",
  "#8a5ab5",
  "#b55a5a",
] as const;

function initialsFromName(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return (parts[0] ?? "?").slice(0, 2).toUpperCase();
  return `${(parts[0] ?? "").slice(0, 1)}${(parts[1] ?? "").slice(0, 1)}`.toUpperCase();
}

export function BenchSection({
  tenantId,
}: {
  readonly tenantId: string | null;
}) {
  const [state, setState] = useState<LoadState<BenchMembership>>({
    kind: "loading",
  });
  const [name, setName] = useState("");
  const [purpose, setPurpose] = useState("");
  const [savedPurpose, setSavedPurpose] = useState("");
  const [iconColor, setIconColor] = useState<string>(ICON_SWATCHES[0]);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);

  useEffect(() => {
    if (tenantId === null) return;
    let cancelled = false;
    setState({ kind: "loading" });
    Promise.all([listMyMemberships(), getBenchSettings(tenantId)])
      .then(([memberships, settings]) => {
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
        setPurpose(settings.purpose ?? "");
        setSavedPurpose(settings.purpose ?? "");
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

  const nameDirty =
    name.trim().length > 0 && name.trim() !== state.data.tenantName;
  const purposeDirty = purpose !== savedPurpose;
  const dirty = nameDirty || purposeDirty;

  function handleSave() {
    const trimmedName = name.trim();
    if (trimmedName.length === 0) return;
    setSaving(true);
    setSaveError(null);
    const tasks: Promise<unknown>[] = [];
    if (nameDirty) {
      tasks.push(
        renameBench(tenantId as string, trimmedName).then((bench) => {
          setState((previous) =>
            previous.kind === "ready"
              ? {
                  kind: "ready",
                  data: { ...previous.data, tenantName: bench.name },
                }
              : previous,
          );
          setName(bench.name);
        }),
      );
    }
    if (purposeDirty) {
      tasks.push(
        patchBenchSettings(tenantId as string, { purpose }).then((settings) => {
          setPurpose(settings.purpose ?? "");
          setSavedPurpose(settings.purpose ?? "");
        }),
      );
    }
    Promise.all(tasks)
      .then(() => {
        setSavedAt(new Date().toLocaleTimeString());
        toast(SETTINGS_STRINGS.settingsSavedToast);
      })
      .catch(() => setSaveError(SETTINGS_STRINGS.benchSaveError))
      .finally(() => setSaving(false));
  }

  return (
    <>
      <BenchSectionView
        name={name}
        purpose={purpose}
        slug={state.data.tenantSlug}
        iconColor={iconColor}
        dirty={dirty}
        saving={saving}
        error={saveError}
        savedAt={savedAt}
        onNameChange={setName}
        onPurposeChange={setPurpose}
        onIconColorChange={setIconColor}
        onSave={handleSave}
        onReset={() => {
          setName(state.data.tenantName);
          setPurpose(savedPurpose);
        }}
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
  purpose = "",
  slug,
  iconColor = ICON_SWATCHES[0],
  dirty,
  saving,
  error,
  savedAt,
  onNameChange,
  onPurposeChange,
  onIconColorChange,
  onSave,
  onReset,
}: {
  readonly name: string;
  readonly purpose?: string;
  readonly slug: string;
  readonly iconColor?: string;
  readonly dirty: boolean;
  readonly saving: boolean;
  readonly error: string | null;
  readonly savedAt: string | null;
  readonly onNameChange: (name: string) => void;
  readonly onPurposeChange?: (purpose: string) => void;
  readonly onIconColorChange?: (color: string) => void;
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
        <span>{SETTINGS_STRINGS.benchPurposeLabel}</span>
        <textarea
          className="settings-textarea"
          value={purpose}
          onChange={(event) => onPurposeChange?.(event.target.value)}
          placeholder={SETTINGS_STRINGS.benchPurposePlaceholder}
          rows={2}
        />
      </label>
      <div className="settings-form-field">
        <span>{SETTINGS_STRINGS.benchIconLabel}</span>
        <div className="settings-wb-icon-row">
          <span
            className="settings-wb-icon-preview"
            style={{ background: iconColor }}
            aria-hidden="true"
          >
            {initialsFromName(name)}
          </span>
          {ICON_SWATCHES.map((color) => (
            <button
              key={color}
              type="button"
              className="settings-wb-swatch"
              style={{ background: color }}
              aria-pressed={iconColor === color}
              aria-label={`Icon color ${color}`}
              onClick={() => onIconColorChange?.(color)}
            />
          ))}
        </div>
        <p className="settings-field-hint">{SETTINGS_STRINGS.benchIconHint}</p>
      </div>
      <label className="settings-form-field">
        <span>{SETTINGS_STRINGS.benchAddressLabel}</span>
        <Input value={slug} disabled readOnly />
      </label>
    </SettingsPanel>
  );
}
