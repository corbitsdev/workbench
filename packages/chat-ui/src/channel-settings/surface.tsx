// Channel settings as a full stage surface (mock § Channel settings):
// channels are tenants, so their settings replace the whole stage — a
// breadcrumb back to the channel, a left nav grouped Shared / Personal /
// Danger zone, and the active section's panel on the right. Never a dialog.
//
// Save still PATCHes name, purpose, pin, and context window (the General
// section's fields); the other sections' field gaps (who-can-post,
// retention, role selects, per-channel grants) are separate tickets — this
// only re-houses what the panel already rendered.

import { toast } from "@corbits/react-ui";
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
  getChannelSettings,
  patchChannelSettings,
} from "../api";
import type { ChannelSettings } from "../api";
import { CHAT_STRINGS } from "../strings";
import { AgentsSection } from "./agents-section";
import { AssistantSection } from "./assistant-section";
import { CapacitySection } from "./capacity-section";
import {
  contextWindowControlState,
  contextWindowPatchValue,
} from "./context-window";
import type { ContextWindowMode } from "./context-window";
import { DangerSection } from "./danger-section";
import { GeneralSection } from "./general-section";
import { InferenceSection } from "@corbits/inference-settings";
import { ApplyProfilePanel } from "@corbits/config-profiles-ui";
import { KeysPluginsSection } from "./keys-plugins-section";
import { MembersSection } from "./members-section";
import { channelSettingsSections } from "./model";
import type { ChannelSettingsSection, ChannelSettingsSectionId } from "./model";
import { NotificationsSection } from "./notifications-section";
import type { NotificationPreference } from "./notifications-section";

type ChannelSettingsData = {
  readonly data: ChannelSettings;
  readonly benchDefault: number;
};

const SECTION_GROUP_ORDER = ["shared", "personal", "danger"] as const;

function groupLabel(group: (typeof SECTION_GROUP_ORDER)[number]): string {
  switch (group) {
    case "shared":
      return CHAT_STRINGS.channelSettingsGroupShared;
    case "personal":
      return CHAT_STRINGS.channelSettingsGroupPersonal;
    case "danger":
      return "";
  }
}

export function ChannelSettingsSurface({
  tenantId,
  channelId,
  channelTitle,
  onBack,
  onInviteParticipant,
  onSaved,
  section = "general",
  onSectionChange,
}: {
  readonly tenantId: string;
  readonly channelId: string;
  readonly channelTitle: string;
  readonly onBack: () => void;
  readonly onInviteParticipant: () => void;
  readonly onSaved?: (settings: ChannelSettings) => void;
  /** Which section is active — host-controlled the same way `settingsOpen`
   * is on `ChatWorkspace`: `/agents` opens straight to Agents rather than
   * the default General, and a deep link (`/c/:id/settings/:section`)
   * lands directly on it. */
  readonly section?: ChannelSettingsSectionId;
  /** Fired when the user picks a different tab, so the host can reflect it
   * in the URL. Omitted, tab clicks have no effect — same contract as
   * `onSettingsOpenChange` being omitted on `ChatWorkspace`. */
  readonly onSectionChange?: (section: ChannelSettingsSectionId) => void;
}) {
  const [query, setQuery] = useState<APIQuery<ChannelSettingsData>>({
    kind: "loading",
  });
  const [name, setName] = useState("");
  const [purpose, setPurpose] = useState("");
  const [pinned, setPinned] = useState(false);
  const [contextWindowMode, setContextWindowMode] =
    useState<ContextWindowMode>("inherit");
  const [contextWindowInput, setContextWindowInput] = useState("");
  const [notificationPref, setNotificationPref] =
    useState<NotificationPreference>("all");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const reload = () => setReloadKey((value) => value + 1);

  useEffect(() => {
    let cancelled = false;
    setQuery({ kind: "loading" });
    Promise.all([
      getChannelSettings(tenantId, channelId),
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
          data: { data: settings, benchDefault: bench.contextWindow },
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
  }, [tenantId, channelId, reloadKey]);

  const ready = query.kind === "ready" ? query.data : undefined;

  // A DM (owner decision: "a DM = a two-member channel tenancy with a
  // trimmed settings surface") is a chat carrying no agent-shaped
  // participant address — the same derivation the host app's sidebar
  // uses to bucket it (`assignChannelBucket`), so this trims Agents
  // without a second signal to keep in sync.
  const hasAgent =
    ready !== undefined &&
    ready.data.participants.some((participant) =>
      isAgentAddress(participant.address),
    );
  const isDm = ready !== undefined && !hasAgent;
  const sections = channelSettingsSections(
    ready !== undefined ? ready.data.kind : "channel",
    isDm,
    hasAgent,
  );
  const firstSection = sections[0];
  if (firstSection === undefined) {
    throw new Error("channelSettingsSections returned no sections");
  }
  const activeSection: ChannelSettingsSection =
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
    patchChannelSettings(tenantId, channelId, {
      "chat/name": name.trim().length > 0 ? name.trim() : ready.data.title,
      "chat/purpose": purpose,
      "chat/pinned": pinned,
      "chat/contextWindow": contextWindowPatchValue(
        contextWindowMode,
        Number.isFinite(overrideValue) ? overrideValue : 0,
      ),
    })
      .then((settings) => {
        toast(CHAT_STRINGS.channelSettingsSavedToast);
        onSaved?.(settings);
      })
      .catch(() => setSaveError(CHAT_STRINGS.channelSettingsSaveError))
      .finally(() => setSaving(false));
  }

  return (
    <div className="channel-settings-stage">
      <div className="channel-settings-topbar">
        <div className="channel-settings-topbar-identity">
          <nav
            className="channel-settings-breadcrumb"
            aria-label={CHAT_STRINGS.channelSettingsBreadcrumbLabel}
          >
            <button type="button" onClick={onBack}>
              {channelTitle}
            </button>
            <span
              className="channel-settings-breadcrumb-sep"
              aria-hidden="true"
            >
              /
            </span>
            <span className="channel-settings-breadcrumb-current">
              {CHAT_STRINGS.channelSettingsBreadcrumbCurrent}
            </span>
          </nav>
          <span className="channel-settings-section-dot" aria-hidden="true" />
          <span className="channel-settings-section-label">
            {activeSection.label}
          </span>
        </div>
        <button
          type="button"
          className="channel-settings-save"
          disabled={saveDisabled}
          onClick={handleSave}
        >
          {saving
            ? CHAT_STRINGS.channelSettingsSaving
            : CHAT_STRINGS.channelSettingsSave}
        </button>
      </div>

      <QueryView query={query} label={CHAT_STRINGS.channelSettingsLoadError}>
        {({ data, benchDefault }) => (
          <div className="channel-settings-shell">
            <nav
              className="channel-settings-nav"
              aria-label={CHAT_STRINGS.channelSettingsNavLabel}
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
                        ? "channel-settings-nav-group channel-settings-nav-group-danger"
                        : "channel-settings-nav-group"
                    }
                  >
                    {label !== "" ? (
                      <div className="channel-settings-nav-group-label">
                        {label}
                      </div>
                    ) : null}
                    {groupSections.map((s) => (
                      <button
                        key={s.id}
                        type="button"
                        className="channel-settings-nav-item"
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

            <div className="channel-settings-panel-area">
              {saveError !== null ? (
                <p className="chat-dialog-error" role="alert">
                  {saveError}
                </p>
              ) : null}

              {activeSection.id === "general" ? (
                <GeneralSection
                  channelId={channelId}
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
                  participants={data.participants}
                  onInvite={onInviteParticipant}
                />
              ) : null}

              {activeSection.id === "agents" ? (
                <AgentsSection
                  participants={data.participants}
                  onInvite={onInviteParticipant}
                />
              ) : null}

              {activeSection.id === "assistant" ? (
                <AssistantSection tenantId={tenantId} channelId={channelId} />
              ) : null}

              {activeSection.id === "keys-plugins" ? (
                <KeysPluginsSection tenantId={tenantId} />
              ) : null}

              {activeSection.id === "inference" ? (
                <>
                  <InferenceSection tenantId={tenantId} />
                  <ApplyProfilePanel tenantId={tenantId} />
                </>
              ) : null}

              {activeSection.id === "capacity" ? (
                <CapacitySection tenantId={tenantId} />
              ) : null}

              {activeSection.id === "notifications" ? (
                <NotificationsSection
                  value={notificationPref}
                  onChange={setNotificationPref}
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
