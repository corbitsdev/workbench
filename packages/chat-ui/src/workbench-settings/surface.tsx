// Workbench settings as a full stage surface (mock § Workbench settings):
// workbenches are tenants, so their settings replace the whole stage — a
// breadcrumb back to the workbench, a left nav grouped Shared / Personal /
// Danger zone, and the active section's panel on the right. Never a dialog.
//
// Save still PATCHes name, purpose, pin, and context window (the General
// section's fields); the other sections' field gaps (who-can-post,
// retention, role selects, per-workbench grants) are separate tickets — this
// only re-houses what the panel already rendered.

import { Button, toast } from "@corbits/react-ui";
import { isAgentAddress } from "@corbits/chat/mentions";
import { useEffect, useState } from "react";

import type { APIQuery } from "@corbits/api-query";
import {
  QueryView,
  UnauthenticatedError,
  describeQueryError,
} from "@corbits/api-query";
import {
  getBenchChatSettings,
  getWorkbenchSettings,
  patchWorkbenchSettings,
} from "../api";
import type { WorkbenchSettings } from "../api";
import { WorkbenchLoadingState } from "../loading-state";
import { CHAT_STRINGS } from "../strings";
import { AgentsSection } from "./agents-section";
import {
  contextWindowControlState,
  contextWindowPatchValue,
} from "./context-window";
import type { ContextWindowMode } from "./context-window";
import { DangerSection } from "./danger-section";
import { GeneralSection } from "./general-section";
import { MembersSection } from "./members-section";
import { workbenchSettingsSections } from "./model";
import type {
  WorkbenchSettingsSection,
  WorkbenchSettingsSectionId,
} from "./model";
import { NotificationsSection } from "./notifications-section";

type WorkbenchSettingsData = {
  readonly data: WorkbenchSettings;
  readonly benchDefault: number;
};

const SECTION_GROUP_ORDER = ["shared", "personal", "danger"] as const;

function groupLabel(group: (typeof SECTION_GROUP_ORDER)[number]): string {
  switch (group) {
    case "shared":
      return CHAT_STRINGS.workbenchSettingsGroupShared;
    case "personal":
      return CHAT_STRINGS.workbenchSettingsGroupPersonal;
    case "danger":
      return "";
  }
}

export function WorkbenchSettingsSurface({
  tenantId,
  workbenchId,
  workbenchTitle,
  onBack,
  onInviteParticipant,
  onSaved,
  section = "general",
  onSectionChange,
  currentUserPrincipalId,
  entityId = null,
  onEntityIdChange,
}: {
  readonly tenantId: string;
  readonly workbenchId: string;
  readonly workbenchTitle: string;
  readonly onBack: () => void;
  readonly onInviteParticipant: () => void;
  readonly onSaved?: (settings: WorkbenchSettings) => void;
  /** The signed-in viewer's own principal id — threaded down to
   * `MembersSection` so their own row's Remove button is disabled.
   * Omitted, no row is treated as "you". */
  readonly currentUserPrincipalId?: string;
  /** Which section is active — host-controlled the same way `settingsOpen`
   * is on `ChatWorkspace`: `/agents` opens straight to Agents rather than
   * the default General, and a deep link (`/w/:id/settings/:section`)
   * lands directly on it. */
  readonly section?: WorkbenchSettingsSectionId;
  /** Fired when the user picks a different tab, so the host can reflect it
   * in the URL. Omitted, tab clicks have no effect — same contract as
   * `onSettingsOpenChange` being omitted on `ChatWorkspace`. */
  readonly onSectionChange?: (section: WorkbenchSettingsSectionId) => void;
  /** Section sub-selection (`/w/:id/settings/:section/:entityId`) —
   * currently used by Agents for the open definition id. */
  readonly entityId?: string | null;
  /** Fired when a section opens or closes its own detail so the host can
   * deepen or clear the entity segment in the URL. */
  readonly onEntityIdChange?: (entityId: string | null) => void;
}) {
  const [query, setQuery] = useState<APIQuery<WorkbenchSettingsData>>({
    kind: "loading",
  });
  const [name, setName] = useState("");
  const [purpose, setPurpose] = useState("");
  const [pinned, setPinned] = useState(false);
  const [contextWindowMode, setContextWindowMode] =
    useState<ContextWindowMode>("inherit");
  const [contextWindowInput, setContextWindowInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const reload = () => setReloadKey((value) => value + 1);

  useEffect(() => {
    let cancelled = false;
    setQuery({ kind: "loading" });
    Promise.all([
      getWorkbenchSettings(tenantId, workbenchId),
      getBenchChatSettings(tenantId),
    ])
      .then(([settings, bench]) => {
        if (cancelled) return;
        const control = contextWindowControlState(settings.contextWindow);
        const storedPurpose = settings.settings["chat/purpose"];
        setName(settings.title);
        setPurpose(typeof storedPurpose === "string" ? storedPurpose : "");
        setPinned(settings.pinned);
        setContextWindowMode(control.mode);
        setContextWindowInput(String(control.displayValue));
        setQuery({
          kind: "ready",
          data: {
            data: settings,
            benchDefault: bench.contextWindow,
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
  }, [tenantId, workbenchId, reloadKey]);

  const ready = query.kind === "ready" ? query.data : undefined;

  // A DM (owner decision: "a DM = a two-member workbench tenancy with a
  // trimmed settings surface") is a chat carrying no agent-shaped
  // participant address — the same derivation the host app's sidebar
  // uses to bucket it (`assignWorkbenchBucket`), so this trims Agents
  // without a second signal to keep in sync.
  const hasAgent =
    ready !== undefined &&
    ready.data.participants.some((participant) =>
      isAgentAddress(participant.address),
    );
  const isDm = ready !== undefined && !hasAgent;
  const sections = workbenchSettingsSections(
    ready !== undefined ? ready.data.kind : "workbench",
    isDm,
  );
  const firstSection = sections[0];
  if (firstSection === undefined) {
    throw new Error("workbenchSettingsSections returned no sections");
  }
  const activeSection: WorkbenchSettingsSection =
    sections.find((s) => s.id === section) ?? firstSection;

  const overrideValue = Number.parseInt(contextWindowInput, 10);
  const overrideValid =
    contextWindowMode === "inherit" ||
    (Number.isFinite(overrideValue) && overrideValue >= 0);
  const saveDisabled = ready === undefined || !overrideValid || saving;

  function handleSave() {
    if (saveDisabled || ready === undefined) return;
    setSaving(true);
    setSaveError(null);
    patchWorkbenchSettings(tenantId, workbenchId, {
      "chat/name": name.trim().length > 0 ? name.trim() : ready.data.title,
      "chat/purpose": purpose,
      "chat/pinned": pinned,
      "chat/contextWindow": contextWindowPatchValue(
        contextWindowMode,
        Number.isFinite(overrideValue) ? overrideValue : 0,
      ),
    })
      .then((settings) => {
        toast(CHAT_STRINGS.workbenchSettingsSavedToast);
        onSaved?.(settings);
      })
      .catch(() => setSaveError(CHAT_STRINGS.workbenchSettingsSaveError))
      .finally(() => setSaving(false));
  }

  return (
    <div className="workbench-settings-stage">
      <div className="workbench-settings-topbar">
        <div className="workbench-settings-topbar-identity">
          <nav
            className="workbench-settings-breadcrumb"
            aria-label={CHAT_STRINGS.workbenchSettingsBreadcrumbLabel}
          >
            <button type="button" onClick={onBack}>
              {workbenchTitle}
            </button>
            <span
              className="workbench-settings-breadcrumb-sep"
              aria-hidden="true"
            >
              /
            </span>
            <span className="workbench-settings-breadcrumb-current">
              {CHAT_STRINGS.workbenchSettingsBreadcrumbCurrent}
            </span>
          </nav>
          <span className="workbench-settings-section-dot" aria-hidden="true" />
          <span className="workbench-settings-section-label">
            {activeSection.label}
          </span>
        </div>
        {/* One primary action visible per view where possible (CL-6215
            EMIL #4): the Agents section has its own scoped "Save
            instructions" action per agent, so the top-bar Save — which
            only ever writes the General section's fields — stays hidden
            rather than sitting alongside a second, unrelated primary. */}
        {activeSection.id !== "agents" ? (
          <Button
            type="button"
            variant="primary"
            size="sm"
            disabled={saveDisabled}
            onClick={handleSave}
          >
            {saving
              ? CHAT_STRINGS.workbenchSettingsSaving
              : CHAT_STRINGS.workbenchSettingsSave}
          </Button>
        ) : null}
      </div>

      <QueryView
        query={query}
        label={CHAT_STRINGS.workbenchSettingsLoadError}
        loadingContent={
          <WorkbenchLoadingState title="Loading workbench settings…" />
        }
      >
        {({ data, benchDefault }) => (
          <div className="workbench-settings-shell">
            <nav
              className="workbench-settings-nav"
              aria-label={CHAT_STRINGS.workbenchSettingsNavLabel}
            >
              {SECTION_GROUP_ORDER.map((group) => {
                const groupSections = sections.filter((s) => s.group === group);
                if (groupSections.length === 0) return null;
                const label = groupLabel(group);
                return (
                  <div
                    key={group}
                    className={
                      group === "danger"
                        ? "workbench-settings-nav-group workbench-settings-nav-group-danger"
                        : "workbench-settings-nav-group"
                    }
                  >
                    {label !== "" ? (
                      <div className="workbench-settings-nav-group-label">
                        {label}
                      </div>
                    ) : null}
                    {groupSections.map((s) => (
                      <button
                        key={s.id}
                        type="button"
                        className="workbench-settings-nav-item"
                        aria-current={
                          s.id === activeSection.id ? "page" : undefined
                        }
                        onClick={() => onSectionChange?.(s.id)}
                      >
                        {s.label}
                      </button>
                    ))}
                  </div>
                );
              })}
            </nav>

            <div className="workbench-settings-panel-area">
              {saveError !== null ? (
                <p className="chat-dialog-error" role="alert">
                  {saveError}
                </p>
              ) : null}

              {activeSection.id === "general" ? (
                <GeneralSection
                  workbenchId={workbenchId}
                  name={name}
                  onNameChange={setName}
                  purpose={purpose}
                  onPurposeChange={setPurpose}
                  pinned={pinned}
                  onPinnedChange={setPinned}
                  contextWindowMode={contextWindowMode}
                  onContextWindowModeChange={setContextWindowMode}
                  contextWindowInput={contextWindowInput}
                  onContextWindowInputChange={setContextWindowInput}
                  benchDefault={benchDefault}
                />
              ) : null}

              {activeSection.id === "members" ? (
                <MembersSection
                  tenantId={tenantId}
                  workbenchId={workbenchId}
                  participants={data.participants}
                  {...(currentUserPrincipalId !== undefined
                    ? { currentUserPrincipalId }
                    : {})}
                  onInvite={onInviteParticipant}
                  onParticipantsChanged={reload}
                />
              ) : null}

              {activeSection.id === "agents" ? (
                <AgentsSection
                  tenantId={tenantId}
                  workbenchId={workbenchId}
                  onInvite={onInviteParticipant}
                  entityId={entityId}
                  {...(onEntityIdChange !== undefined
                    ? { onEntityIdChange }
                    : {})}
                />
              ) : null}

              {activeSection.id === "notifications" ? (
                <NotificationsSection
                  tenantId={tenantId}
                  workbenchId={workbenchId}
                />
              ) : null}

              {activeSection.id === "danger" ? <DangerSection /> : null}
            </div>
          </div>
        )}
      </QueryView>
    </div>
  );
}
