// Assistant section: a channel's agent's own display name and
// instructions (its system prompt), read and saved through
// `@corbits/agent-directory`'s routes — a different backend than every
// other section here (which all PATCH through the channel settings
// surface's own top-bar Save). That split is real, not an invented
// idiom: this section edits the *agent's* record, not the channel's, so
// it carries its own load/save/cancel state and its own inline error,
// the same shape `ChannelSettingsSurface` uses for its one PATCH.

import { useEffect, useState } from "react";
import { Button, EmptyState, Input, Skeleton, toast } from "@corbits/react-ui";
import { CircleAlert } from "lucide-react";

import {
  getAgentInstructions,
  getChannelAgent,
  updateAgentInstructions,
} from "../api";
import { CHAT_STRINGS } from "../strings";

type LoadState =
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string }
  | {
      readonly kind: "ready";
      readonly definitionId: string;
      readonly name: string;
      readonly systemPrompt: string;
    };

export function AssistantSection({
  tenantId,
  channelId,
}: {
  readonly tenantId: string;
  readonly channelId: string;
}) {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [name, setName] = useState("");
  const [instructions, setInstructions] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setState({ kind: "loading" });
    getChannelAgent(tenantId, channelId)
      .then((agent) =>
        getAgentInstructions(tenantId, agent.definitionId).then(
          (instructionsResponse) => ({
            definitionId: agent.definitionId,
            instructionsResponse,
          }),
        ),
      )
      .then(({ definitionId, instructionsResponse }) => {
        if (cancelled) return;
        setName(instructionsResponse.name);
        setInstructions(instructionsResponse.systemPrompt);
        setState({
          kind: "ready",
          definitionId,
          name: instructionsResponse.name,
          systemPrompt: instructionsResponse.systemPrompt,
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
  }, [tenantId, channelId]);

  if (state.kind === "loading") {
    return <Skeleton className="query-skeleton" />;
  }

  if (state.kind === "error") {
    return (
      <EmptyState
        icon={<CircleAlert />}
        title={CHAT_STRINGS.channelSettingsAssistantLoadError}
        description={state.message}
      />
    );
  }

  const dirty = name !== state.name || instructions !== state.systemPrompt;

  function handleCancel() {
    if (state.kind !== "ready") return;
    setName(state.name);
    setInstructions(state.systemPrompt);
    setSaveError(null);
  }

  function handleSave() {
    if (state.kind !== "ready" || !dirty) return;
    setSaving(true);
    setSaveError(null);
    updateAgentInstructions(tenantId, state.definitionId, {
      name,
      systemPrompt: instructions,
    })
      .then((saved) => {
        toast(CHAT_STRINGS.channelSettingsAssistantSavedToast);
        setState({
          kind: "ready",
          definitionId: state.definitionId,
          name: saved.name,
          systemPrompt: saved.systemPrompt,
        });
      })
      .catch(() => setSaveError(CHAT_STRINGS.channelSettingsAssistantSaveError))
      .finally(() => setSaving(false));
  }

  return (
    <div className="channel-settings-pane">
      <label className="chat-settings-field">
        <span>{CHAT_STRINGS.channelSettingsAssistantNameLabel}</span>
        <Input value={name} onChange={(event) => setName(event.target.value)} />
      </label>
      <label className="chat-settings-field">
        <span>{CHAT_STRINGS.channelSettingsAssistantInstructionsLabel}</span>
        <textarea
          className="chat-textarea"
          value={instructions}
          onChange={(event) => setInstructions(event.target.value)}
          rows={10}
        />
      </label>
      <p className="chat-settings-field-hint">
        {CHAT_STRINGS.channelSettingsAssistantInstructionsHint}
      </p>
      {saveError !== null ? (
        <p className="chat-dialog-error" role="alert">
          {saveError}
        </p>
      ) : null}
      <div className="chat-settings-field-actions">
        <Button
          type="button"
          variant="outline"
          onClick={handleCancel}
          disabled={!dirty || saving}
        >
          {CHAT_STRINGS.channelSettingsAssistantCancel}
        </Button>
        <Button
          type="button"
          variant="primary"
          onClick={handleSave}
          disabled={!dirty || saving}
        >
          {saving
            ? CHAT_STRINGS.channelSettingsAssistantSaving
            : CHAT_STRINGS.channelSettingsAssistantSave}
        </Button>
      </div>
    </div>
  );
}
