// The channel header's details panel (Slack's pattern: a side panel opened
// from the channel header for deeper config, distinct from the sidebar
// row's quick-action ellipsis menu in `sidebar.tsx`). Shows name, pinned,
// the context-window inherit/override control, and the participants list
// with the existing invite flow — never a second copy of it.

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
} from "@corbits/react-ui";
import { isAgentAddress } from "@corbits/chat/mentions";
import { CircleAlert, UserPlus } from "lucide-react";
import { useEffect, useState } from "react";

import {
  getBenchChatSettings,
  getChannelSettings,
  patchChannelSettings,
} from "./api";
import type { ChannelSettings, ParticipantRecord } from "./api";
import { CHAT_STRINGS } from "./strings";

export type ContextWindowMode = "inherit" | "override";

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
  const [name, setName] = useState("");
  const [pinned, setPinned] = useState(false);
  const [contextWindowMode, setContextWindowMode] =
    useState<ContextWindowMode>("inherit");
  const [contextWindowInput, setContextWindowInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setState({ kind: "loading" });
    setSaveError(null);
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
        if (!cancelled) {
          setState({
            kind: "error",
            message: cause instanceof Error ? cause.message : String(cause),
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [open, tenantId, channelId]);

  if (!open) return null;

  const parsedOverride = Number.parseInt(contextWindowInput, 10);
  const overrideValid =
    contextWindowMode === "inherit" ||
    (Number.isInteger(parsedOverride) &&
      parsedOverride >= 0 &&
      parsedOverride <= 200);

  function handleSave() {
    if (!overrideValid) return;
    setSaving(true);
    setSaveError(null);
    patchChannelSettings(tenantId, channelId, {
      "chat/name": name.trim(),
      "chat/pinned": pinned,
      "chat/contextWindow": contextWindowPatchValue(
        contextWindowMode,
        parsedOverride,
      ),
    })
      .then((updated) => {
        const control = contextWindowControlState(updated.contextWindow);
        setContextWindowMode(control.mode);
        setContextWindowInput(String(control.displayValue));
        onSaved?.(updated);
        onOpenChange(false);
      })
      .catch(() => setSaveError(CHAT_STRINGS.channelSettingsSaveError))
      .finally(() => setSaving(false));
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
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
            <div className="chat-settings-panel">
              {saveError !== null && (
                <p className="chat-dialog-error" role="alert">
                  {saveError}
                </p>
              )}
              <label className="chat-settings-field">
                <span>{CHAT_STRINGS.channelSettingsNameLabel}</span>
                <Input
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
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
                <span>{CHAT_STRINGS.channelSettingsContextWindowLabel}</span>
                <div
                  className="chat-context-window-control"
                  role="radiogroup"
                  aria-label={CHAT_STRINGS.channelSettingsContextWindowLabel}
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
              <div className="chat-settings-field">
                <span>{CHAT_STRINGS.channelSettingsParticipantsLabel}</span>
                <ParticipantsList participants={state.data.participants} />
                <Button
                  variant="outline"
                  size="sm"
                  onClick={onInviteParticipant}
                >
                  <UserPlus />
                  {CHAT_STRINGS.inviteAgentAction}
                </Button>
              </div>
              <Button
                variant="primary"
                disabled={!overrideValid || saving}
                onClick={handleSave}
              >
                {saving
                  ? CHAT_STRINGS.channelSettingsSaving
                  : CHAT_STRINGS.channelSettingsSave}
              </Button>
            </div>
          )}
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}

function ParticipantsList({
  participants,
}: {
  readonly participants: readonly ParticipantRecord[];
}) {
  if (participants.length === 0) {
    return (
      <p className="chat-settings-field-hint">
        {CHAT_STRINGS.channelSettingsNoParticipants}
      </p>
    );
  }
  return (
    <ul className="chat-settings-participants-list">
      {participants.map((participant) => (
        <li key={participant.address}>
          {isAgentAddress(participant.address)
            ? `@${participant.handle}`
            : participant.handle}
        </li>
      ))}
    </ul>
  );
}
