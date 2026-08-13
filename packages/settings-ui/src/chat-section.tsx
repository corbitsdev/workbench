// The "Chats & channels" settings section: the bench-wide chat defaults
// every channel inherits unless it sets its own override. A channel's own
// override now lives on the channel itself (its header's settings panel in
// `@corbits/chat-ui`, not here) — this section is bench-wide defaults only.
// Every fetch and mutation goes through `@corbits/chat-ui`'s own API
// client — this section only composes the form around it, never
// re-implements the wire contract.

import { getBenchChatSettings, patchBenchChatSettings } from "@corbits/chat-ui";
import type { BenchChatSettings } from "@corbits/chat-ui";
import {
  EmptyState,
  Input,
  SettingsPanel,
  Skeleton,
  toast,
} from "@corbits/react-ui";
import { CircleAlert } from "lucide-react";
import { useEffect, useState } from "react";

import { contextWindowLabel, parseContextWindowInput } from "./context-window";
import { errorMessage, type LoadState } from "./load-state";
import { SETTINGS_STRINGS } from "./strings";

/**
 * The bench-defaults form's markup on its own, taking already-resolved
 * display fields — kept separate from `ChatSection` for the same reason
 * `BenchSectionView` is: directly renderable in tests without a fetch stub.
 */
export function ChatSectionView({
  contextWindowInput,
  contextWindowLabel: contextWindowLabelText,
  dirty,
  saving,
  error,
  savedAt,
  onContextWindowChange,
  onSave,
  onReset,
}: {
  readonly contextWindowInput: string;
  readonly contextWindowLabel: string;
  readonly dirty: boolean;
  readonly saving: boolean;
  readonly error: string | null;
  readonly savedAt: string | null;
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
  const [state, setState] = useState<LoadState<BenchChatSettings>>({
    kind: "loading",
  });
  const [contextWindowInput, setContextWindowInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);

  useEffect(() => {
    if (tenantId === null) return;
    let cancelled = false;
    setState({ kind: "loading" });
    getBenchChatSettings(tenantId)
      .then((settings) => {
        if (cancelled) return;
        setContextWindowInput(String(settings.contextWindow));
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

  const parsedContextWindow = parseContextWindowInput(contextWindowInput);
  const contextWindowValid = parsedContextWindow !== null;
  const dirty =
    contextWindowValid && parsedContextWindow !== state.data.contextWindow;

  function handleSave() {
    if (parsedContextWindow === null) return;
    setSaving(true);
    setSaveError(null);
    patchBenchChatSettings(tenantId as string, {
      "chat/contextWindow": parsedContextWindow,
    })
      .then((updated) => {
        setState({ kind: "ready", data: updated });
        setContextWindowInput(String(updated.contextWindow));
        setSavedAt(new Date().toLocaleTimeString());
        toast(SETTINGS_STRINGS.settingsSavedToast);
      })
      .catch(() => setSaveError(SETTINGS_STRINGS.chatSaveError))
      .finally(() => setSaving(false));
  }

  return (
    <ChatSectionView
      contextWindowInput={contextWindowInput}
      contextWindowLabel={
        contextWindowValid
          ? contextWindowLabel(parsedContextWindow)
          : SETTINGS_STRINGS.chatContextWindowInvalidLabel
      }
      dirty={dirty}
      saving={saving}
      error={
        saveError ??
        (contextWindowValid ? null : SETTINGS_STRINGS.chatContextWindowInvalid)
      }
      savedAt={savedAt}
      onContextWindowChange={setContextWindowInput}
      onSave={handleSave}
      onReset={() => setContextWindowInput(String(state.data.contextWindow))}
    />
  );
}
