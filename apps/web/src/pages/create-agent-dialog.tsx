// The create-agent form: identity (name, handle, description) and
// definition (system prompt, model). Every field maps onto something
// `POST /api/tenants/:t/agent-definitions` can actually honor — see
// `@corbits/agent-directory`'s `CreateAgentDefinitionInput` — so this
// component asks for nothing the platform would silently ignore.

import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  IntakeForm,
  intakeFieldsComplete,
} from "@corbits/react-ui";
import type { IntakeField } from "@corbits/react-ui";
import { useState } from "react";

import type { CatalogModel } from "../agents-api";
import { AgentDirectoryError, createAgentDefinition } from "../agents-api";
import type { AgentDefinition } from "../agents-api";
import { AgentSkillsPicker } from "./agent-skills-picker";

const HANDLE_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

type FormValues = {
  readonly name: string;
  readonly handle: string;
  readonly description: string;
  readonly systemPrompt: string;
  readonly model: string;
  readonly skills: readonly string[];
};

const EMPTY_VALUES: FormValues = {
  name: "",
  handle: "",
  description: "",
  systemPrompt: "",
  model: "",
  skills: [],
};

function fieldsFor(models: readonly CatalogModel[]): readonly IntakeField[] {
  const base: IntakeField[] = [
    {
      name: "name",
      label: "Name",
      type: "text",
      required: true,
      placeholder: "Research Buddy",
    },
    {
      name: "handle",
      label: "Handle",
      type: "text",
      required: true,
      placeholder: "research-buddy",
      help: "Lowercase letters, digits, and hyphens only — this becomes the agent's address.",
    },
    {
      name: "description",
      label: "Description",
      type: "textarea",
      placeholder: "What this agent is for",
    },
    {
      name: "systemPrompt",
      label: "System prompt",
      type: "textarea",
      required: true,
      placeholder: "You are...",
      help: "Instructions the agent follows on every turn.",
    },
  ];
  if (models.length === 0) return base;
  return [
    ...base,
    {
      name: "model",
      label: "Model",
      type: "select",
      options: models.map((model) => ({
        value: model.canonicalName,
        label: model.displayName ?? model.canonicalName,
      })),
      help: "Left unset, the workbench's catalog default is used.",
    },
  ];
}

/** Every reason a submission is not yet valid, in plain language — never
 * a generic "invalid form". */
function validationIssues(values: FormValues): readonly string[] {
  const issues: string[] = [];
  if (values.name.trim() === "") issues.push("Name is required.");
  if (values.handle.trim() === "") {
    issues.push("Handle is required.");
  } else if (!HANDLE_PATTERN.test(values.handle)) {
    issues.push(
      "Handle must be lowercase letters, digits, and hyphens only, with no leading or trailing hyphen.",
    );
  }
  if (values.systemPrompt.trim() === "") {
    issues.push("System prompt is required.");
  }
  return issues;
}

export function CreateAgentDialog({
  open,
  onOpenChange,
  tenantId,
  models,
  modelsError,
  onCreated,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly tenantId: string;
  readonly models: readonly CatalogModel[];
  /** Inline note when the catalog failed; the rest of the form still works. */
  readonly modelsError?: string;
  readonly onCreated: (definition: AgentDefinition) => void;
}) {
  const [values, setValues] = useState<FormValues>(EMPTY_VALUES);
  const [handleTouched, setHandleTouched] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [showIssues, setShowIssues] = useState(false);

  function reset() {
    setValues(EMPTY_VALUES);
    setHandleTouched(false);
    setSubmitError(null);
    setShowIssues(false);
  }

  function handleOpenChange(next: boolean) {
    if (!next) reset();
    onOpenChange(next);
  }

  function handleFormChange(next: Record<string, unknown>) {
    const name = typeof next.name === "string" ? next.name : values.name;
    const nextHandle =
      typeof next.handle === "string" ? next.handle : values.handle;
    const handleEdited = !handleTouched && nextHandle !== values.handle;
    setValues({
      name,
      handle: handleTouched || handleEdited ? nextHandle : slugify(name),
      description: typeof next.description === "string" ? next.description : "",
      systemPrompt:
        typeof next.systemPrompt === "string" ? next.systemPrompt : "",
      model: typeof next.model === "string" ? next.model : "",
      skills: values.skills,
    });
    if (handleEdited) setHandleTouched(true);
  }

  function handleSkillsChange(next: readonly string[]) {
    setValues((prev) => ({ ...prev, skills: next }));
  }

  const issues = validationIssues(values);
  const fields = fieldsFor(models);

  async function handleSubmit() {
    if (issues.length > 0) {
      setShowIssues(true);
      return;
    }
    setSubmitting(true);
    setSubmitError(null);
    try {
      const created = await createAgentDefinition(tenantId, {
        name: values.name.trim(),
        handle: values.handle.trim(),
        systemPrompt: values.systemPrompt.trim(),
        ...(values.description.trim() !== ""
          ? { description: values.description.trim() }
          : {}),
        ...(values.model.trim() !== "" ? { model: values.model.trim() } : {}),
        ...(values.skills.length > 0 ? { skills: values.skills } : {}),
      });
      reset();
      onOpenChange(false);
      onCreated(created);
    } catch (cause) {
      setSubmitError(
        cause instanceof AgentDirectoryError
          ? cause.message
          : "Could not create the agent.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create agent</DialogTitle>
          <DialogDescription>
            Define a new agent this workbench can invite into a channel and
            launch.
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          {submitError !== null && (
            <p className="mb-3 text-sm text-destructive" role="alert">
              {submitError}
            </p>
          )}
          {showIssues && issues.length > 0 && (
            <ul
              className="mb-3 list-inside list-disc text-sm text-destructive"
              role="alert"
            >
              {issues.map((issue) => (
                <li key={issue}>{issue}</li>
              ))}
            </ul>
          )}
          {modelsError !== undefined && (
            <p className="mb-3 text-sm text-muted-foreground" role="status">
              Model catalog unavailable — the agent will use the workbench
              default.
            </p>
          )}
          <IntakeForm
            fields={fields}
            values={values}
            onChange={handleFormChange}
            idPrefix="create-agent"
            disabled={submitting}
          />
          <div className="mt-4 flex flex-col gap-1.5">
            <span className="text-sm font-medium">Skills</span>
            <AgentSkillsPicker
              selected={values.skills}
              onChange={handleSkillsChange}
              idPrefix="create-agent"
              disabled={submitting}
            />
          </div>
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
          <Button
            type="button"
            onClick={() => void handleSubmit()}
            disabled={submitting || !intakeFieldsComplete(fields, values)}
          >
            {submitting ? "Creating…" : "Create agent"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
