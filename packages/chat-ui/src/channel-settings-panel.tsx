// Stage surface for channel settings (mock § Channel settings): tabbed
// General / Members / Agents / Access / Notifications / Danger. 1:1 chats
// trim to a smaller set. Save still PATCHes name, pin, and context window;
// purpose and notifications are draft UI until their stores land.

import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  EmptyState,
  Input,
  Skeleton,
  Switch,
  toast,
} from "@corbits/react-ui";
import { isAgentAddress } from "@corbits/chat/mentions";
import { CircleAlert, UserPlus } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import {
  getBenchChatSettings,
  getChannelSettings,
  patchChannelSettings,
} from "./api";
import type { ChannelSettings, ParticipantRecord } from "./api";
import { CHAT_STRINGS } from "./strings";

export type ContextWindowMode = "inherit" | "override";

export type ChannelSettingsTabId =
  "general" | "members" | "agents" | "access" | "notifications" | "danger";

/**
 * The two-state control's own resolution, independent of React: what mode
 * the toggle should show and what number the (possibly-disabled) numeric
 * field should display — the "Use bench default (N)" vs override state a
 * channel's resolved context window folds down to.
 */
export function contextWindowControlState(resolved: {
  readonly value: number;
  readonly source: "inherit" | "override";
}): { readonly mode: ContextWindowMode; readonly displayValue: number } {
  return { mode: resolved.source, displayValue: resolved.value };
}

/**
 * What a context-window edit should PATCH: switching to "inherit" always
 * clears the override back to `null` regardless of whatever the field shows;
 * switching to (or staying on) "override" sends the field's own value,
 * clamped and validated the same way the panel's numeric input already is.
 */
export function contextWindowPatchValue(
  mode: ContextWindowMode,
  overrideValue: number,
): number | null {
  return mode === "inherit" ? null : overrideValue;
}

/**
 * Tabs available for a channel kind. 1:1 chats drop Members and Danger so
 * the surface stays short (owner decision / mock).
 */
export function channelSettingsTabs(
  channelKind: string,
): readonly ChannelSettingsTabId[] {
  if (channelKind === "chat") {
    return ["general", "agents", "access", "notifications"] as const;
  }
  return [
    "general",
    "members",
    "agents",
    "access",
    "notifications",
    "danger",
  ] as const;
}

export function channelSettingsTabLabel(tab: ChannelSettingsTabId): string {
  switch (tab) {
    case "general":
      return CHAT_STRINGS.channelSettingsTabGeneral;
    case "members":
      return CHAT_STRINGS.channelSettingsTabMembers;
    case "agents":
      return CHAT_STRINGS.channelSettingsTabAgents;
    case "access":
      return CHAT_STRINGS.channelSettingsTabAccess;
    case "notifications":
      return CHAT_STRINGS.channelSettingsTabNotifications;
    case "danger":
      return CHAT_STRINGS.channelSettingsTabDanger;
  }
}

type LoadState =
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string }
  | {
      readonly kind: "ready";
      readonly data: ChannelSettings;
      readonly benchDefault: number;
    };

export function ChannelSettingsPanel({
  open,
  onOpenChange,
  tenantId,
  channelId,
  onInviteParticipant,
  onSaved,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly tenantId: string;
  readonly channelId: string;
  readonly onInviteParticipant: () => void;
  readonly onSaved?: (settings: ChannelSettings) => void;
}) {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [tab, setTab] = useState<ChannelSettingsTabId>("general");
  const [name, setName] = useState("");
  const [purpose, setPurpose] = useState("");
  const [pinned, setPinned] = useState(false);
  const [contextWindowMode, setContextWindowMode] =
    useState<ContextWindowMode>("inherit");
  const [contextWindowInput, setContextWindowInput] = useState("");
  const [notificationPref, setNotificationPref] = useState<
    "all" | "mentions" | "mute"
  >("all");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setState({ kind: "loading" });
    setSaveError(null);
    setTab("general");
    setPurpose("");
    setNotificationPref("all");
    Promise.all([
      getChannelSettings(tenantId, channelId),
      getBenchChatSettings(tenantId),
    ])
      .then(([settings, bench]) => {
        if (cancelled) return;
        const control = contextWindowControlState(settings.contextWindow);
        setName(settings.title);
        setPinned(settings.pinned);
        setContextWindowMode(control.mode);
        setContextWindowInput(String(control.displayValue));
        setState({
          kind: "ready",
          data: settings,
          benchDefault: bench.contextWindow,
        });
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setState({
          kind: "error",
          message: cause instanceof Error ? cause.message : String(cause),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [open, tenantId, channelId]);

  const tabs = useMemo(
    () =>
      state.kind === "ready"
        ? channelSettingsTabs(state.data.kind)
        : channelSettingsTabs("channel"),
    [state],
  );

  const overrideValue = Number.parseInt(contextWindowInput, 10);
  const overrideValid =
    contextWindowMode === "inherit" ||
    (Number.isFinite(overrideValue) && overrideValue >= 0);

  function handleSave() {
    if (!overrideValid || state.kind !== "ready") return;
    setSaving(true);
    setSaveError(null);
    patchChannelSettings(tenantId, channelId, {
      "chat/name": name.trim().length > 0 ? name.trim() : state.data.title,
      "chat/pinned": pinned,
      "chat/contextWindow": contextWindowPatchValue(
        contextWindowMode,
        Number.isFinite(overrideValue) ? overrideValue : 0,
      ),
    })
      .then((settings) => {
        onSaved?.(settings);
        onOpenChange(false);
        toast(CHAT_STRINGS.channelSettingsSavedToast);
      })
      .catch(() => setSaveError(CHAT_STRINGS.channelSettingsSaveError))
      .finally(() => setSaving(false));
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="chat-settings-dialog">
        <DialogHeader>
          <DialogTitle>{CHAT_STRINGS.channelSettingsDialogTitle}</DialogTitle>
          <DialogDescription>
            {CHAT_STRINGS.channelSettingsDialogDescription}
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          {state.kind === "loading" ? (
            <Skeleton className="query-skeleton" />
          ) : state.kind === "error" ? (
            <EmptyState
              icon={<CircleAlert />}
              title={CHAT_STRINGS.channelSettingsLoadError}
              description={state.message}
            />
          ) : (
            <div className="chat-settings-body">
              <div
                role="tablist"
                aria-label={CHAT_STRINGS.channelSettingsTabsLabel}
                className="chat-settings-tabs"
              >
                {tabs.map((id) => (
                  <button
                    key={id}
                    type="button"
                    role="tab"
                    aria-selected={tab === id}
                    className="chat-settings-tab"
                    onClick={() => setTab(id)}
                  >
                    {channelSettingsTabLabel(id)}
                  </button>
                ))}
              </div>

              {saveError !== null && (
                <p className="chat-dialog-error" role="alert">
                  {saveError}
                </p>
              )}

              {tab === "general" ? (
                <div className="chat-settings-pane" role="tabpanel">
                  <label className="chat-settings-field">
                    <span>{CHAT_STRINGS.channelSettingsNameLabel}</span>
                    <Input
                      value={name}
                      onChange={(event) => setName(event.target.value)}
                    />
                  </label>
                  <label className="chat-settings-field">
                    <span>{CHAT_STRINGS.channelSettingsPurposeLabel}</span>
                    <textarea
                      className="chat-textarea"
                      value={purpose}
                      onChange={(event) => setPurpose(event.target.value)}
                      placeholder={
                        CHAT_STRINGS.channelSettingsPurposePlaceholder
                      }
                      rows={2}
                    />
                    <span className="chat-settings-field-hint">
                      {CHAT_STRINGS.channelSettingsPurposeHint}
                    </span>
                  </label>
                  <label className="chat-settings-field chat-settings-field-inline">
                    <span>{CHAT_STRINGS.channelSettingsPinnedLabel}</span>
                    <Switch
                      checked={pinned}
                      onCheckedChange={setPinned}
                      label={CHAT_STRINGS.channelSettingsPinnedLabel}
                    />
                  </label>
                  <p className="chat-settings-field-hint">
                    {CHAT_STRINGS.channelSettingsPinnedDescription}
                  </p>
                  <div className="chat-settings-field">
                    <span>
                      {CHAT_STRINGS.channelSettingsContextWindowLabel}
                    </span>
                    <div
                      className="chat-context-window-control"
                      role="radiogroup"
                      aria-label={
                        CHAT_STRINGS.channelSettingsContextWindowLabel
                      }
                    >
                      <label className="chat-context-window-option">
                        <input
                          type="radio"
                          name={`context-window-mode-${channelId}`}
                          checked={contextWindowMode === "inherit"}
                          onChange={() => setContextWindowMode("inherit")}
                        />
                        {CHAT_STRINGS.channelSettingsUseBenchDefault(
                          state.benchDefault,
                        )}
                      </label>
                      <label className="chat-context-window-option">
                        <input
                          type="radio"
                          name={`context-window-mode-${channelId}`}
                          checked={contextWindowMode === "override"}
                          onChange={() => setContextWindowMode("override")}
                        />
                        {CHAT_STRINGS.channelSettingsUseOverride}
                      </label>
                      <Input
                        value={contextWindowInput}
                        disabled={contextWindowMode === "inherit"}
                        inputMode="numeric"
                        onChange={(event) =>
                          setContextWindowInput(event.target.value)
                        }
                      />
                    </div>
                  </div>
                  <p className="chat-settings-field-hint">
                    {CHAT_STRINGS.channelSettingsContextWindowDescription}
                  </p>
                  <div className="chat-settings-callout">
                    <strong>{CHAT_STRINGS.channelSettingsDeliveryTitle}</strong>
                    <p>{CHAT_STRINGS.channelSettingsDeliveryBody}</p>
                  </div>
                </div>
              ) : null}

              {tab === "members" ? (
                <div className="chat-settings-pane" role="tabpanel">
                  <ParticipantsSplit
                    participants={state.data.participants}
                    onInvite={onInviteParticipant}
                  />
                </div>
              ) : null}

              {tab === "agents" ? (
                <div className="chat-settings-pane" role="tabpanel">
                  <AgentParticipants
                    participants={state.data.participants}
                    onInvite={onInviteParticipant}
                  />
                  <div className="chat-settings-callout">
                    <strong>{CHAT_STRINGS.channelSettingsAutonomyTitle}</strong>
                    <p>{CHAT_STRINGS.channelSettingsAutonomyBody}</p>
                  </div>
                </div>
              ) : null}

              {tab === "access" ? (
                <div className="chat-settings-pane" role="tabpanel">
                  <p className="chat-settings-field-hint">
                    {CHAT_STRINGS.channelSettingsAccessBody}
                  </p>
                </div>
              ) : null}

              {tab === "notifications" ? (
                <div className="chat-settings-pane" role="tabpanel">
                  <div
                    role="radiogroup"
                    aria-label={CHAT_STRINGS.channelSettingsNotificationsLabel}
                    className="chat-settings-choice-row"
                  >
                    {(
                      [
                        ["all", CHAT_STRINGS.channelSettingsNotifyAll],
                        [
                          "mentions",
                          CHAT_STRINGS.channelSettingsNotifyMentions,
                        ],
                        ["mute", CHAT_STRINGS.channelSettingsNotifyMute],
                      ] as const
                    ).map(([id, label]) => (
                      <button
                        key={id}
                        type="button"
                        className="chat-kind-card"
                        aria-pressed={notificationPref === id}
                        onClick={() => setNotificationPref(id)}
                      >
                        <span className="chat-kind-card-title">{label}</span>
                      </button>
                    ))}
                  </div>
                  <p className="chat-settings-field-hint">
                    {CHAT_STRINGS.channelSettingsNotificationsHint}
                  </p>
                </div>
              ) : null}

              {tab === "danger" ? (
                <div className="chat-settings-pane" role="tabpanel">
                  <div className="chat-settings-callout chat-settings-callout-danger">
                    <strong>{CHAT_STRINGS.channelSettingsArchiveTitle}</strong>
                    <p>{CHAT_STRINGS.channelSettingsArchiveBody}</p>
                  </div>
                </div>
              ) : null}

              {tab === "general" || tab === "members" || tab === "agents" ? (
                <div className="chat-settings-actions">
                  {tab === "general" ? (
                    <Button
                      variant="primary"
                      disabled={!overrideValid || saving}
                      onClick={handleSave}
                    >
                      {saving
                        ? CHAT_STRINGS.channelSettingsSaving
                        : CHAT_STRINGS.channelSettingsSave}
                    </Button>
                  ) : null}
                </div>
              ) : null}
            </div>
          )}
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}

function ParticipantsSplit({
  participants,
  onInvite,
}: {
  readonly participants: readonly ParticipantRecord[];
  readonly onInvite: () => void;
}) {
  const people = participants.filter((p) => !isAgentAddress(p.address));
  return (
    <div className="chat-settings-field">
      <span>{CHAT_STRINGS.channelSettingsPeopleLabel}</span>
      {people.length === 0 ? (
        <p className="chat-settings-field-hint">
          {CHAT_STRINGS.channelSettingsNoPeople}
        </p>
      ) : (
        <ul className="chat-settings-participants-list">
          {people.map((participant) => (
            <li key={participant.address}>{participant.handle}</li>
          ))}
        </ul>
      )}
      <Button variant="outline" size="sm" onClick={onInvite}>
        <UserPlus />
        {CHAT_STRINGS.inviteAgentAction}
      </Button>
    </div>
  );
}

function AgentParticipants({
  participants,
  onInvite,
}: {
  readonly participants: readonly ParticipantRecord[];
  readonly onInvite: () => void;
}) {
  const agents = participants.filter((p) => isAgentAddress(p.address));
  return (
    <div className="chat-settings-field">
      <span>{CHAT_STRINGS.channelSettingsAgentsLabel}</span>
      {agents.length === 0 ? (
        <p className="chat-settings-field-hint">
          {CHAT_STRINGS.channelSettingsNoAgents}
        </p>
      ) : (
        <ul className="chat-settings-participants-list">
          {agents.map((participant) => (
            <li key={participant.address}>@{participant.handle}</li>
          ))}
        </ul>
      )}
      <Button variant="outline" size="sm" onClick={onInvite}>
        <UserPlus />
        {CHAT_STRINGS.inviteAgentAction}
      </Button>
    </div>
  );
}
