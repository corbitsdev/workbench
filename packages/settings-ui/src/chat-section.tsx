// The "Chats & channels" settings section: pick a channel, then edit its
// name, pinned flag, and conversation-memory window. Every fetch and mutation
// goes through `@corbits/chat-ui`'s own API client — this section only
// composes the picker and the form around it, never re-implements the wire
// contract.

import type { Channel, ChannelSettings } from "@corbits/chat-ui";
import {
  getChannelSettings,
  listChannels,
  patchChannelSettings,
} from "@corbits/chat-ui";
import {
  EmptyState,
  Input,
  SettingsPanel,
  Skeleton,
  Switch,
} from "@corbits/react-ui";
import { CircleAlert } from "lucide-react";
import { useEffect, useState } from "react";

import { contextWindowLabel, parseContextWindowInput } from "./context-window";
import { errorMessage, type LoadState } from "./load-state";
import { SETTINGS_STRINGS } from "./strings";

function rawContextWindow(settings: ChannelSettings): number | undefined {
  const value = settings.settings["chat/contextWindow"];
  return typeof value === "number" ? value : undefined;
}

export function ChannelPicker({
  channels,
  selectedId,
  onSelect,
}: {
  readonly channels: readonly Channel[];
  readonly selectedId: string | null;
  readonly onSelect: (id: string) => void;
}) {
  return (
    <label className="settings-form-field">
      <span>{SETTINGS_STRINGS.chatPickerLabel}</span>
      <select
        className="settings-channel-picker"
        value={selectedId ?? ""}
        onChange={(event) => onSelect(event.target.value)}
      >
        {channels.map((channel) => (
          <option key={channel.id} value={channel.id}>
            {channel.title.trim().length === 0 ? "Untitled" : channel.title}
          </option>
        ))}
      </select>
    </label>
  );
}

function ChannelEditor({
  tenantId,
  channelId,
  onSaved,
}: {
  readonly tenantId: string;
  readonly channelId: string;
  readonly onSaved: (channel: ChannelSettings) => void;
}) {
  const [state, setState] = useState<LoadState<ChannelSettings>>({
    kind: "loading",
  });
  const [name, setName] = useState("");
  const [pinned, setPinned] = useState(false);
  const [contextWindowInput, setContextWindowInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setState({ kind: "loading" });
    getChannelSettings(tenantId, channelId)
      .then((settings) => {
        if (cancelled) return;
        setName(settings.title);
        setPinned(settings.pinned);
        const raw = rawContextWindow(settings);
        setContextWindowInput(raw === undefined ? "" : String(raw));
        setState({ kind: "ready", data: settings });
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setState({ kind: "error", message: errorMessage(cause) });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [tenantId, channelId]);

  if (state.kind === "loading") return <Skeleton className="query-skeleton" />;
  if (state.kind === "error") {
    return (
      <EmptyState
        icon={<CircleAlert />}
        title={`Couldn't load ${SETTINGS_STRINGS.chatSettingsLoadError}`}
        description={state.message}
      />
    );
  }

  const parsedContextWindow = parseContextWindowInput(contextWindowInput);
  const contextWindowValid = parsedContextWindow !== null;
  const trimmedName = name.trim();
  const originalContextWindow = rawContextWindow(state.data);
  const dirty =
    trimmedName.length > 0 &&
    (trimmedName !== state.data.title ||
      pinned !== state.data.pinned ||
      (contextWindowValid && parsedContextWindow !== originalContextWindow));

  function handleSave() {
    if (!contextWindowValid || trimmedName.length === 0) return;
    setSaving(true);
    setSaveError(null);
    patchChannelSettings(tenantId, channelId, {
      "chat/name": trimmedName,
      "chat/pinned": pinned,
      ...(parsedContextWindow === undefined
        ? {}
        : { "chat/contextWindow": parsedContextWindow }),
    })
      .then((updated) => {
        setState({ kind: "ready", data: updated });
        onSaved(updated);
        setSavedAt(new Date().toLocaleTimeString());
      })
      .catch(() => setSaveError(SETTINGS_STRINGS.chatSaveError))
      .finally(() => setSaving(false));
  }

  return (
    <ChannelEditorView
      name={name}
      pinned={pinned}
      contextWindowInput={contextWindowInput}
      contextWindowLabel={
        contextWindowValid
          ? contextWindowLabel(parsedContextWindow)
          : SETTINGS_STRINGS.chatContextWindowDefault
      }
      dirty={dirty}
      saving={saving}
      error={
        saveError ??
        (contextWindowValid
          ? null
          : "Conversation memory must be a whole number.")
      }
      savedAt={savedAt}
      onNameChange={setName}
      onPinnedChange={setPinned}
      onContextWindowChange={setContextWindowInput}
      onSave={handleSave}
      onReset={() => {
        setName(state.data.title);
        setPinned(state.data.pinned);
        const raw = rawContextWindow(state.data);
        setContextWindowInput(raw === undefined ? "" : String(raw));
      }}
    />
  );
}

/**
 * The channel-settings form's markup on its own, taking already-resolved
 * display fields — kept separate from `ChannelEditor` for the same reason
 * `BenchSectionView` is: directly renderable in tests without a fetch stub.
 */
export function ChannelEditorView({
  name,
  pinned,
  contextWindowInput,
  contextWindowLabel: contextWindowLabelText,
  dirty,
  saving,
  error,
  savedAt,
  onNameChange,
  onPinnedChange,
  onContextWindowChange,
  onSave,
  onReset,
}: {
  readonly name: string;
  readonly pinned: boolean;
  readonly contextWindowInput: string;
  readonly contextWindowLabel: string;
  readonly dirty: boolean;
  readonly saving: boolean;
  readonly error: string | null;
  readonly savedAt: string | null;
  readonly onNameChange: (name: string) => void;
  readonly onPinnedChange: (pinned: boolean) => void;
  readonly onContextWindowChange: (value: string) => void;
  readonly onSave: () => void;
  readonly onReset: () => void;
}) {
  return (
    <SettingsPanel
      title={SETTINGS_STRINGS.chatSectionTitle}
      description={SETTINGS_STRINGS.chatSectionDescription}
      onSave={onSave}
      dirty={dirty}
      saving={saving}
      error={error}
      savedAt={savedAt}
      onReset={onReset}
    >
      <label className="settings-form-field">
        <span>{SETTINGS_STRINGS.chatNameLabel}</span>
        <Input
          value={name}
          onChange={(event) => onNameChange(event.target.value)}
        />
      </label>
      <label className="settings-form-field settings-form-field-inline">
        <span>{SETTINGS_STRINGS.chatPinnedLabel}</span>
        <Switch
          checked={pinned}
          onCheckedChange={onPinnedChange}
          label={SETTINGS_STRINGS.chatPinnedLabel}
        />
      </label>
      <p className="settings-field-hint">
        {SETTINGS_STRINGS.chatPinnedDescription}
      </p>
      <label className="settings-form-field">
        <span>{SETTINGS_STRINGS.chatContextWindowLabel}</span>
        <Input
          value={contextWindowInput}
          onChange={(event) => onContextWindowChange(event.target.value)}
          placeholder={SETTINGS_STRINGS.chatContextWindowPlaceholder}
          inputMode="numeric"
        />
      </label>
      <p className="settings-field-hint">
        {SETTINGS_STRINGS.chatContextWindowDescription} —{" "}
        {contextWindowLabelText}
      </p>
    </SettingsPanel>
  );
}

export function ChatSection({
  tenantId,
}: {
  readonly tenantId: string | null;
}) {
  const [state, setState] = useState<LoadState<readonly Channel[]>>({
    kind: "loading",
  });
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    if (tenantId === null) return;
    let cancelled = false;
    setState({ kind: "loading" });
    Promise.all([
      listChannels(tenantId, "channel"),
      listChannels(tenantId, "chat"),
    ])
      .then(([channels, chats]) => {
        if (cancelled) return;
        const all = [...channels, ...chats];
        setState({ kind: "ready", data: all });
        setSelectedId((current) => current ?? all[0]?.id ?? null);
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
        title={`Couldn't load ${SETTINGS_STRINGS.chatLoadError}`}
        description={state.message}
      />
    );
  }
  if (state.data.length === 0) {
    return (
      <EmptyState
        title={SETTINGS_STRINGS.chatPickerEmptyTitle}
        description={SETTINGS_STRINGS.chatPickerEmptyDescription}
      />
    );
  }

  return (
    <div className="settings-chat-section">
      <ChannelPicker
        channels={state.data}
        selectedId={selectedId}
        onSelect={setSelectedId}
      />
      {selectedId !== null && (
        <ChannelEditor
          key={selectedId}
          tenantId={tenantId}
          channelId={selectedId}
          onSaved={(updated) => {
            setState((previous) =>
              previous.kind === "ready"
                ? {
                    kind: "ready",
                    data: previous.data.map((channel) =>
                      channel.id === updated.id
                        ? {
                            ...channel,
                            title: updated.title,
                            pinned: updated.pinned,
                          }
                        : channel,
                    ),
                  }
                : previous,
            );
          }}
        />
      )}
    </div>
  );
}
