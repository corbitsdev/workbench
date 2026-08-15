// Assistant section: one editor per agent participant a channel
// actually has, each reading and saving its own name/instructions
// through `@corbits/agent-directory`'s routes — a different backend
// than every other section here (which all PATCH through the channel
// settings surface's own top-bar Save). That split is real, not an
// invented idiom: this section edits the *agent's* record, not the
// channel's, so each editor carries its own load/save/cancel state and
// its own inline error, the same shape `ChannelSettingsSurface` uses
// for its one PATCH — just one instance of that shape per agent rather
// than one for the whole section, since a channel can carry more than
// one invited agent and each edits its own definition independently.

import { useEffect, useState } from "react";
import { Button, EmptyState, Input, Skeleton, toast } from "@corbits/react-ui";
import { CircleAlert } from "lucide-react";

import {
  describeChatError,
  getAgentInstructions,
  listChannelAgents,
  refreshChannelAgent,
  updateAgentInstructions,
} from "../api";
import type { ChannelAgent } from "../api";
import { CHAT_STRINGS } from "../strings";

type SectionState =
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "ready"; readonly agents: readonly ChannelAgent[] };

export function AssistantSection({
  tenantId,
  channelId,
}: {
  readonly tenantId: string;
  readonly channelId: string;
}) {
  const [state, setState] = useState<SectionState>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    setState({ kind: "loading" });
    listChannelAgents(tenantId, channelId)
      .then((agents) => {
        if (!cancelled) setState({ kind: "ready", agents });
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setState({
          kind: "error",
          message: describeChatError(cause, "Couldn't load the assistant."),
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

  if (state.agents.length === 0) {
    return (
      <p className="chat-settings-field-hint">
        {CHAT_STRINGS.channelSettingsAssistantNoAgents}
      </p>
    );
  }

  return (
    <div className="channel-settings-pane">
      {state.agents.map((agent) => (
        <AssistantAgentEditor
          key={agent.address}
          tenantId={tenantId}
          channelId={channelId}
          agent={agent}
        />
      ))}
    </div>
  );
}

type EditorState =
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string }
  | {
      readonly kind: "ready";
      readonly name: string;
      readonly systemPrompt: string;
    };

function AssistantAgentEditor({
  tenantId,
  channelId,
  agent,
}: {
  readonly tenantId: string;
  readonly channelId: string;
  readonly agent: ChannelAgent;
}) {
  const [state, setState] = useState<EditorState>({ kind: "loading" });
  const [name, setName] = useState("");
  const [instructions, setInstructions] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getAgentInstructions(tenantId, agent.definitionId)
      .then((loaded) => {
        if (cancelled) return;
        setName(loaded.name);
        setInstructions(loaded.systemPrompt);
        setState({
          kind: "ready",
          name: loaded.name,
          systemPrompt: loaded.systemPrompt,
        });
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setState({
          kind: "error",
          message: describeChatError(cause, "Couldn't load the assistant."),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [tenantId, agent.definitionId]);

  const label =
    state.kind === "ready" && state.name.trim() !== ""
      ? state.name
      : `@${agent.handle}`;

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
    updateAgentInstructions(tenantId, agent.definitionId, {
      name,
      systemPrompt: instructions,
    })
      .then((saved) =>
        refreshChannelAgent(tenantId, channelId, agent.address).then(
          () => saved,
        ),
      )
      .then((saved) => {
        toast(CHAT_STRINGS.channelSettingsAssistantSavedToast);
        setState({
          kind: "ready",
          name: saved.name,
          systemPrompt: saved.systemPrompt,
        });
      })
      .catch(() => setSaveError(CHAT_STRINGS.channelSettingsAssistantSaveError))
      .finally(() => setSaving(false));
  }

  return (
    <div className="chat-settings-agent-block">
      <h3 className="chat-settings-agent-block-title">{label}</h3>
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
