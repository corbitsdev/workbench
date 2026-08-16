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
//
// Below the instructions form, each editor also carries a Capabilities
// area (current tools/skills/model, plus a guided add fed from the
// tenant's live inventory) and a History area (every commit to this
// agent's instructions and capabilities, with restore) — mirroring the
// Skills settings section's own version-history treatment, since an
// agent definition and a skill are both git-backed hub assets read
// through the same shape of routes.

import { useEffect, useState } from "react";
import {
  Badge,
  Button,
  EmptyState,
  Input,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  formatRelativeTime,
  toast,
} from "@corbits/react-ui";
import { CircleAlert } from "lucide-react";

import {
  addAgentCapability,
  describeChatError,
  getAgentInstructions,
  listAgentVersions,
  listCapabilityInventory,
  listChannelAgents,
  refreshChannelAgent,
  restoreAgentVersion,
  updateAgentInstructions,
} from "../api";
import type {
  AgentDetail,
  AgentVersion,
  CapabilityAddition,
  CapabilityInventory,
  ChannelAgent,
} from "../api";
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
  | { readonly kind: "ready"; readonly detail: AgentDetail };

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
      .then((detail) => {
        if (cancelled) return;
        setName(detail.name);
        setInstructions(detail.systemPrompt);
        setState({ kind: "ready", detail });
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
    state.kind === "ready" && state.detail.name.trim() !== ""
      ? state.detail.name
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

  const dirty =
    name !== state.detail.name || instructions !== state.detail.systemPrompt;

  function handleCancel() {
    if (state.kind !== "ready") return;
    setName(state.detail.name);
    setInstructions(state.detail.systemPrompt);
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
        setState((prev) =>
          prev.kind === "ready"
            ? {
                kind: "ready",
                detail: { ...prev.detail, ...saved },
              }
            : prev,
        );
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

      <CapabilitiesBlock
        tenantId={tenantId}
        channelId={channelId}
        agent={agent}
        detail={state.detail}
        onChanged={(detail) => setState({ kind: "ready", detail })}
      />

      <HistoryBlock
        tenantId={tenantId}
        channelId={channelId}
        agent={agent}
        onRestored={(detail) => {
          setName(detail.name);
          setInstructions(detail.systemPrompt);
          setState({ kind: "ready", detail });
        }}
      />
    </div>
  );
}

// --- Capabilities ---

type InventoryState =
  | { readonly kind: "loading" }
  | { readonly kind: "error" }
  | { readonly kind: "ready"; readonly inventory: CapabilityInventory };

function CapabilitiesBlock({
  tenantId,
  channelId,
  agent,
  detail,
  onChanged,
}: {
  readonly tenantId: string;
  readonly channelId: string;
  readonly agent: ChannelAgent;
  readonly detail: AgentDetail;
  readonly onChanged: (detail: AgentDetail) => void;
}) {
  const [inventoryState, setInventoryState] = useState<InventoryState>({
    kind: "loading",
  });
  const [kind, setKind] = useState<CapabilityAddition["kind"]>("toolPackage");
  const [choice, setChoice] = useState("");
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    listCapabilityInventory(tenantId)
      .then((inventory) => {
        if (!cancelled) setInventoryState({ kind: "ready", inventory });
      })
      .catch(() => {
        if (!cancelled) setInventoryState({ kind: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, [tenantId]);

  const options =
    inventoryState.kind === "ready"
      ? kind === "toolPackage"
        ? inventoryState.inventory.toolPackages
            .map((entry) => entry.name)
            .filter(
              (name) =>
                !detail.toolPackagePins.some((pin) => pin.name === name),
            )
        : kind === "skill"
          ? inventoryState.inventory.skills
              .map((entry) => entry.name)
              .filter((name) => !detail.skills.includes(name))
          : inventoryState.inventory.models
              .map((entry) => entry.canonicalName)
              .filter((name) => name !== detail.model)
      : [];

  function addition(): CapabilityAddition | undefined {
    if (choice === "") return undefined;
    if (kind === "model") return { kind: "model", canonicalName: choice };
    return { kind, name: choice };
  }

  function handleAdd() {
    const next = addition();
    if (next === undefined) return;
    setAdding(true);
    setAddError(null);
    addAgentCapability(tenantId, agent.definitionId, next)
      .then((capabilities) =>
        refreshChannelAgent(tenantId, channelId, agent.address).then(
          () => capabilities,
        ),
      )
      .then((capabilities) => {
        toast(CHAT_STRINGS.channelSettingsAssistantSavedToast);
        onChanged({ ...detail, ...capabilities });
        setChoice("");
      })
      .catch(() =>
        setAddError(CHAT_STRINGS.channelSettingsAssistantAddCapabilityError),
      )
      .finally(() => setAdding(false));
  }

  const hasCapabilities =
    detail.toolPackagePins.length > 0 ||
    detail.skills.length > 0 ||
    detail.model !== undefined;

  return (
    <div className="chat-settings-agent-block-section">
      <h4>{CHAT_STRINGS.channelSettingsAssistantCapabilitiesTitle}</h4>
      <p className="chat-settings-field-hint">
        {CHAT_STRINGS.channelSettingsAssistantCapabilitiesHint}
      </p>

      {hasCapabilities ? (
        <ul className="chat-settings-capability-list">
          {detail.toolPackagePins.map((pin) => (
            <li key={`tool-${pin.name}`}>
              <Badge tone="neutral">{pin.name}</Badge>
            </li>
          ))}
          {detail.skills.map((skillName) => (
            <li key={`skill-${skillName}`}>
              <Badge tone="neutral">{skillName}</Badge>
            </li>
          ))}
          {detail.model !== undefined ? (
            <li key="model">
              <Badge tone="neutral">
                {CHAT_STRINGS.channelSettingsAssistantModelLabel}:{" "}
                {detail.model}
              </Badge>
            </li>
          ) : null}
        </ul>
      ) : (
        <p className="chat-settings-field-hint">
          {CHAT_STRINGS.channelSettingsAssistantNoCapabilities}
        </p>
      )}

      {inventoryState.kind === "error" ? (
        <p className="chat-dialog-error" role="alert">
          {CHAT_STRINGS.channelSettingsAssistantCapabilityInventoryError}
        </p>
      ) : (
        <div className="chat-settings-capability-add">
          <label className="chat-settings-field">
            <span>
              {CHAT_STRINGS.channelSettingsAssistantAddCapabilityLabel}
            </span>
            <select
              value={kind}
              onChange={(event) => {
                setKind(event.target.value as CapabilityAddition["kind"]);
                setChoice("");
              }}
              disabled={inventoryState.kind !== "ready"}
            >
              <option value="toolPackage">
                {CHAT_STRINGS.channelSettingsAssistantAddCapabilityKindTool}
              </option>
              <option value="skill">
                {CHAT_STRINGS.channelSettingsAssistantAddCapabilityKindSkill}
              </option>
              <option value="model">
                {CHAT_STRINGS.channelSettingsAssistantAddCapabilityKindModel}
              </option>
            </select>
          </label>
          <label className="chat-settings-field">
            <select
              value={choice}
              onChange={(event) => setChoice(event.target.value)}
              disabled={inventoryState.kind !== "ready" || options.length === 0}
            >
              <option value="" />
              {options.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </label>
          <Button
            type="button"
            variant="outline"
            onClick={handleAdd}
            disabled={choice === "" || adding}
          >
            {adding
              ? CHAT_STRINGS.channelSettingsAssistantAddCapabilityAdding
              : CHAT_STRINGS.channelSettingsAssistantAddCapabilityButton}
          </Button>
        </div>
      )}
      {addError !== null ? (
        <p className="chat-dialog-error" role="alert">
          {addError}
        </p>
      ) : null}
    </div>
  );
}

// --- History ---

type HistoryState =
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "ready"; readonly versions: readonly AgentVersion[] };

function HistoryBlock({
  tenantId,
  channelId,
  agent,
  onRestored,
}: {
  readonly tenantId: string;
  readonly channelId: string;
  readonly agent: ChannelAgent;
  readonly onRestored: (detail: AgentDetail) => void;
}) {
  const [state, setState] = useState<HistoryState>({ kind: "loading" });
  const [restoring, setRestoring] = useState<string | null>(null);
  const [restoreError, setRestoreError] = useState<string | null>(null);

  function reload() {
    setState({ kind: "loading" });
    listAgentVersions(tenantId, agent.definitionId)
      .then((versions) => setState({ kind: "ready", versions }))
      .catch((cause: unknown) =>
        setState({
          kind: "error",
          message: describeChatError(
            cause,
            CHAT_STRINGS.channelSettingsAssistantHistoryLoadError,
          ),
        }),
      );
  }

  useEffect(reload, [tenantId, agent.definitionId]);

  function handleRestore(commitSha: string) {
    setRestoring(commitSha);
    setRestoreError(null);
    restoreAgentVersion(tenantId, agent.definitionId, commitSha)
      .then((detail) =>
        refreshChannelAgent(tenantId, channelId, agent.address).then(
          () => detail,
        ),
      )
      .then((detail) => {
        toast(CHAT_STRINGS.channelSettingsAssistantSavedToast);
        onRestored(detail);
        reload();
      })
      .catch(() =>
        setRestoreError(
          CHAT_STRINGS.channelSettingsAssistantHistoryRestoreError,
        ),
      )
      .finally(() => setRestoring(null));
  }

  return (
    <div className="chat-settings-agent-block-section">
      <h4>{CHAT_STRINGS.channelSettingsAssistantHistoryTitle}</h4>
      <p className="chat-settings-field-hint">
        {CHAT_STRINGS.channelSettingsAssistantHistoryHint}
      </p>

      {state.kind === "loading" ? (
        <Skeleton className="query-skeleton" />
      ) : state.kind === "error" ? (
        <p className="chat-dialog-error" role="alert">
          {state.message}
        </p>
      ) : state.versions.length === 0 ? (
        <p className="chat-settings-field-hint">
          {CHAT_STRINGS.channelSettingsAssistantHistoryEmpty}
        </p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Change</TableHead>
              <TableHead>Who</TableHead>
              <TableHead>When</TableHead>
              <TableHead className="text-right">Action</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {state.versions.map((version) => (
              <TableRow key={version.commitSha}>
                <TableCell className="text-sm" title={version.commitSha}>
                  {version.message}
                  {version.current ? (
                    <Badge tone="success" className="ml-2">
                      {CHAT_STRINGS.channelSettingsAssistantHistoryCurrent}
                    </Badge>
                  ) : null}
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {version.author}
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {formatRelativeTime(version.committedAtIso, Date.now())}
                </TableCell>
                <TableCell className="text-right">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={version.current || restoring !== null}
                    onClick={() => handleRestore(version.commitSha)}
                  >
                    {restoring === version.commitSha
                      ? CHAT_STRINGS.channelSettingsAssistantHistoryRestoring
                      : CHAT_STRINGS.channelSettingsAssistantHistoryRestore}
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {restoreError !== null ? (
        <p className="chat-dialog-error" role="alert">
          {restoreError}
        </p>
      ) : null}
    </div>
  );
}
