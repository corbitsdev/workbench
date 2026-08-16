// The agent-create panel (CL-6074): the shared component behind both
// Settings → Agents' "New agent" action and the new-chat picker's
// "New agent…" affordance — one component, one create path, wired to
// land the person in a chat with the agent it just created (see each
// entry point's `onCreated`, and `../agent-chat-launch.ts` for the
// shared "exact same path picking an existing agent uses" hop).
//
// Deliberately small above the fold: an identity swatch, a Name field,
// and "Get started" is the whole happy path — a plain-language purpose
// is optional, a quiet secondary field, not a gate. Either way, one
// click on "Get started" asks Myra to draft a starting system prompt
// (and optionally a description/model/skills) via `draftAgentDefinition`
// (`@corbits/task-planner`'s one-shot drafting port, CL-6074) — with a
// purpose, from that brief; with none, a friendly general-purpose draft
// the person teaches in the conversation that follows — then deploys
// with that draft. The Suggestions row below the button is the same
// flow with the name+purpose pre-written: every card describes
// something this workbench can actually do today. Handle, model
// override, and skills sit behind "Advanced", collapsed by default, for
// anyone who wants to steer them.
//
// Drafting fails closed, on purpose: if Myra can't draft a prompt
// (unavailable, timed out, an unparseable reply), this panel never
// falls back to a canned template — it surfaces the plain-language
// failure and reveals a manual "System prompt" field in Advanced
// instead, so the person can write their own and try again.
//
// The identity swatch is preview-only: `@corbits/agent-directory` has
// no field to persist a chosen avatar tone today, so picking one only
// drives this panel's own live `Avatar` preview — the smallest honest
// identity picker, not a promise the platform can't keep yet (a real
// avatar system is future work, tracked separately, not built in this
// lane).

import {
  Avatar,
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  IntakeForm,
} from "@corbits/react-ui";
import type { AvatarTone, IntakeField } from "@corbits/react-ui";
import { useEffect, useState } from "react";

import { ApiQueryError } from "@corbits/api-query";

import type { AgentDefinition, CatalogModel } from "../agents-api";
import {
  createAgentDefinition,
  draftAgentDefinition,
  listCatalogModels,
} from "../agents-api";
import { AgentSkillsPicker } from "./agent-skills-picker";

const HANDLE_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function initialsFromName(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0]!.slice(0, 2);
  return `${words[0]![0]}${words[1]![0]}`;
}

const AVATAR_TONES: readonly { readonly tone: AvatarTone; readonly label: string }[] = [
  { tone: "neutral", label: "Muted" },
  { tone: "agent", label: "Primary" },
  { tone: "agent2", label: "Accent" },
  { tone: "agent3", label: "Success" },
];

type FormValues = {
  readonly name: string;
  readonly purpose: string;
  readonly handle: string;
  readonly model: string;
  readonly skills: readonly string[];
  /** Only read when drafting has already failed once — see the module
   * doc's "fails closed" note. */
  readonly manualSystemPrompt: string;
};

const EMPTY_VALUES: FormValues = {
  name: "",
  purpose: "",
  handle: "",
  model: "",
  skills: [],
  manualSystemPrompt: "",
};

const NAME_FIELD: readonly IntakeField[] = [
  {
    name: "name",
    label: "Name",
    type: "text",
    required: true,
    placeholder: "Research Buddy",
  },
];

function advancedFields(
  models: readonly CatalogModel[],
  draftFailed: boolean,
): readonly IntakeField[] {
  const base: IntakeField[] = [
    {
      name: "handle",
      label: "Handle",
      type: "text",
      required: true,
      placeholder: "research-buddy",
      help: "Lowercase letters, digits, and hyphens only — this becomes the agent's address.",
    },
  ];
  const withModel: IntakeField[] =
    models.length === 0
      ? base
      : [
          ...base,
          {
            name: "model",
            label: "Model",
            type: "select",
            options: models.map((model) => ({
              value: model.canonicalName,
              label: model.displayName ?? model.canonicalName,
            })),
            help: "Left unset, Myra picks one — or the workbench default if drafting fails.",
          },
        ];
  if (!draftFailed) return withModel;
  return [
    ...withModel,
    {
      name: "manualSystemPrompt",
      label: "System prompt",
      type: "textarea",
      required: true,
      placeholder: "You are...",
      help: "Myra couldn't draft one — write the instructions this agent follows on every turn.",
    },
  ];
}

type Suggestion = {
  readonly name: string;
  readonly cardDescription: string;
  readonly purpose: string;
};

/** Every card here names something this workbench can actually deploy
 * today (`@corbits/workflow-catalog`'s "Morning brief", "Granola call
 * notes", and general conversational research) — plain copy, no
 * capability this platform can't back up yet. */
const SUGGESTIONS: readonly Suggestion[] = [
  {
    name: "Morning Brief",
    cardDescription: "Preps a digest on schedule",
    purpose:
      "Preps a short digest each morning of what happened overnight and what's on deck today.",
  },
  {
    name: "Call Notes",
    cardDescription: "Turns Granola calls into summaries",
    purpose: "Turns Granola call recordings into clear, shareable summaries.",
  },
  {
    name: "Research Assistant",
    cardDescription: "Digs into questions you drop in chat",
    purpose:
      "Digs into questions dropped in chat and comes back with a grounded answer.",
  },
  {
    name: "Chat Digest",
    cardDescription: "Summarizes a chat on schedule",
    purpose: "Summarizes recent activity in a chat on a recurring schedule.",
  },
];

/** The single reason "Get started" is disabled, in plain language — the
 * disabled state explains itself rather than leaving a person to guess.
 * `null` once nothing blocks submission. Purpose is never a gate — a
 * name alone is a supported happy path. */
function blockedReason(
  values: FormValues,
  draftFailed: boolean,
): string | null {
  if (values.name.trim() === "") return "Add a name to continue.";
  if (values.handle.trim() === "" || !HANDLE_PATTERN.test(values.handle)) {
    return "Fix the handle below — lowercase letters, digits, and hyphens only.";
  }
  if (draftFailed && values.manualSystemPrompt.trim() === "") {
    return "Write a system prompt below to continue.";
  }
  return null;
}

type ModelsState =
  | { readonly kind: "idle" }
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly models: readonly CatalogModel[] }
  | { readonly kind: "error"; readonly message: string };

export function CreateAgentPanel({
  open,
  onOpenChange,
  tenantId,
  onCreated,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly tenantId: string;
  readonly onCreated: (definition: AgentDefinition) => void;
}) {
  const [values, setValues] = useState<FormValues>(EMPTY_VALUES);
  const [tone, setTone] = useState<AvatarTone>("agent");
  const [handleTouched, setHandleTouched] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [draftFailed, setDraftFailed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [modelsState, setModelsState] = useState<ModelsState>({
    kind: "idle",
  });

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setModelsState({ kind: "loading" });
    listCatalogModels(tenantId)
      .then((models) => {
        if (!cancelled) setModelsState({ kind: "ready", models });
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setModelsState({
            kind: "error",
            message: cause instanceof Error ? cause.message : String(cause),
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [open, tenantId]);

  function reset() {
    setValues(EMPTY_VALUES);
    setTone("agent");
    setHandleTouched(false);
    setAdvancedOpen(false);
    setDraftFailed(false);
    setSubmitError(null);
  }

  function handleOpenChange(next: boolean) {
    if (!next) reset();
    onOpenChange(next);
  }

  function handleNameChange(next: Record<string, unknown>) {
    const name = typeof next.name === "string" ? next.name : values.name;
    setValues((prev) => ({
      ...prev,
      name,
      handle: handleTouched ? prev.handle : slugify(name),
    }));
  }

  function handlePurposeChange(value: string) {
    setValues((prev) => ({ ...prev, purpose: value }));
  }

  function handleAdvancedChange(next: Record<string, unknown>) {
    const handle =
      typeof next.handle === "string" ? next.handle : values.handle;
    const model = typeof next.model === "string" ? next.model : values.model;
    const manualSystemPrompt =
      typeof next.manualSystemPrompt === "string"
        ? next.manualSystemPrompt
        : values.manualSystemPrompt;
    if (handle !== values.handle) setHandleTouched(true);
    setValues((prev) => ({ ...prev, handle, model, manualSystemPrompt }));
  }

  function handleSkillsChange(next: readonly string[]) {
    setValues((prev) => ({ ...prev, skills: next }));
  }

  const models = modelsState.kind === "ready" ? modelsState.models : [];
  const blocked = blockedReason(values, draftFailed);

  async function handleSubmit(effective?: {
    readonly name: string;
    readonly purpose: string;
  }) {
    const name = effective?.name ?? values.name;
    const purpose = effective?.purpose ?? values.purpose;
    const handle = handleTouched ? values.handle : slugify(name);
    const effectiveValues: FormValues = { ...values, name, purpose, handle };
    const reason = blockedReason(effectiveValues, draftFailed);
    if (reason !== null) {
      setValues(effectiveValues);
      setAdvancedOpen(true);
      return;
    }

    setValues(effectiveValues);
    setSubmitting(true);
    setSubmitError(null);

    let systemPrompt: string;
    let description = purpose.trim();
    let model = values.model.trim();
    let skills = values.skills;

    if (draftFailed) {
      systemPrompt = values.manualSystemPrompt.trim();
    } else {
      try {
        const draft = await draftAgentDefinition(tenantId, {
          name: name.trim(),
          ...(purpose.trim() !== "" ? { purpose: purpose.trim() } : {}),
        });
        systemPrompt = draft.systemPrompt;
        if (draft.description !== undefined) description = draft.description;
        if (model === "" && draft.modelPreference !== undefined) {
          model = draft.modelPreference;
        }
        if (skills.length === 0 && draft.skills !== undefined) {
          skills = draft.skills;
        }
      } catch (cause) {
        setDraftFailed(true);
        setAdvancedOpen(true);
        setSubmitError(
          cause instanceof ApiQueryError
            ? cause.message
            : "Myra couldn't draft a starting prompt for this agent.",
        );
        setSubmitting(false);
        return;
      }
    }

    try {
      const created = await createAgentDefinition(tenantId, {
        name: name.trim(),
        handle: handle.trim(),
        systemPrompt,
        ...(description !== "" ? { description } : {}),
        ...(model !== "" ? { model } : {}),
        ...(skills.length > 0 ? { skills } : {}),
      });
      reset();
      onOpenChange(false);
      onCreated(created);
    } catch (cause) {
      setSubmitError(
        cause instanceof ApiQueryError
          ? cause.message
          : "Could not create the agent.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  function applySuggestion(suggestion: Suggestion) {
    void handleSubmit({ name: suggestion.name, purpose: suggestion.purpose });
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent side="right">
        <DialogHeader>
          <DialogTitle>New agent</DialogTitle>
          <DialogDescription>
            A name is enough to start — Myra drafts the starting
            instructions, and you teach it the rest in chat.
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          {submitError !== null && (
            <p className="mb-3 text-sm text-destructive" role="alert">
              {submitError}
            </p>
          )}
          {modelsState.kind === "error" && (
            <p className="mb-3 text-sm text-muted-foreground" role="status">
              Model catalog unavailable — the agent will use the workbench
              default.
            </p>
          )}

          <div className="create-agent-identity">
            <Avatar
              initials={initialsFromName(values.name)}
              label={values.name.trim() === "" ? "New agent" : values.name}
              tone={tone}
              size="lg"
            />
            <div
              role="group"
              aria-label="Agent color"
              className="create-agent-tone-row"
            >
              {AVATAR_TONES.map((entry) => (
                <button
                  key={entry.tone}
                  type="button"
                  aria-label={entry.label}
                  aria-pressed={tone === entry.tone}
                  className={`create-agent-tone-swatch create-agent-tone-${entry.tone}`}
                  disabled={submitting}
                  onClick={() => setTone(entry.tone)}
                />
              ))}
            </div>
          </div>

          <IntakeForm
            fields={NAME_FIELD}
            values={values}
            onChange={handleNameChange}
            idPrefix="create-agent"
            disabled={submitting}
            className="mt-3"
          />

          <label className="create-agent-quiet-field">
            <span>What should this agent do? (optional)</span>
            <textarea
              id="create-agent-purpose"
              value={values.purpose}
              onChange={(event) => handlePurposeChange(event.target.value)}
              placeholder="Leave blank and teach it in chat"
              disabled={submitting}
              rows={2}
            />
          </label>

          <div className="mt-3 flex flex-col gap-2">
            {blocked !== null && (
              <p className="text-xs text-muted-foreground">{blocked}</p>
            )}
            <Button
              type="button"
              onClick={() => void handleSubmit()}
              disabled={submitting || blocked !== null}
            >
              {submitting ? "Creating…" : "Get started"}
            </Button>
          </div>

          <div className="create-agent-suggestions">
            <span className="create-agent-suggestions-label">
              Suggestions
            </span>
            <div className="create-agent-suggestions-grid">
              {SUGGESTIONS.map((suggestion) => (
                <button
                  key={suggestion.name}
                  type="button"
                  className="create-agent-suggestion-card"
                  disabled={submitting}
                  onClick={() => applySuggestion(suggestion)}
                >
                  <span className="create-agent-suggestion-title">
                    {suggestion.name}
                  </span>
                  <span className="create-agent-suggestion-desc">
                    {suggestion.cardDescription}
                  </span>
                </button>
              ))}
            </div>
          </div>

          <details
            className="create-agent-advanced"
            open={advancedOpen}
            onToggle={(event) => setAdvancedOpen(event.currentTarget.open)}
          >
            <summary>Advanced</summary>
            <div className="create-agent-advanced-body">
              <IntakeForm
                fields={advancedFields(models, draftFailed)}
                values={values}
                onChange={handleAdvancedChange}
                idPrefix="create-agent-advanced"
                disabled={submitting}
              />
              <div className="flex flex-col gap-1.5">
                <span className="text-sm font-medium">Skills</span>
                <AgentSkillsPicker
                  tenantId={tenantId}
                  selected={values.skills}
                  onChange={handleSkillsChange}
                  idPrefix="create-agent"
                  disabled={submitting}
                />
              </div>
            </div>
          </details>
        </DialogBody>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => handleOpenChange(false)}
            disabled={submitting}
          >
            Cancel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
