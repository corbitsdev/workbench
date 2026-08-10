// The create-skill form: identity (name, description) and the skill
// body itself (the instructions/tools text). There is no skill
// registry in the hub yet, so this dialog never POSTs — it collects
// the values a future registry will expect and hands them to
// `onCreated` so the page can decide what to do once a seam is real.

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

export type SkillDraft = {
  readonly name: string;
  readonly description: string;
  readonly body: string;
};

type FormValues = {
  readonly name: string;
  readonly description: string;
  readonly body: string;
};

const EMPTY_VALUES: FormValues = {
  name: "",
  description: "",
  body: "",
};

const FIELDS: readonly IntakeField[] = [
  {
    name: "name",
    label: "Name",
    type: "text",
    required: true,
    placeholder: "Summarize transcript",
  },
  {
    name: "description",
    label: "Description",
    type: "textarea",
    placeholder: "What this skill does and when to use it",
  },
  {
    name: "body",
    label: "Skill body",
    type: "textarea",
    required: true,
    placeholder: "Instructions, tools, and guardrails this skill packages…",
    help: "The instructions an agent definition can declare and a bench can install.",
  },
];

/** Every reason a submission is not yet valid, in plain language — never
 * a generic "invalid form". Exported so the create flow can be proven
 * without SSR-rendering the portal-based dialog (see chat-ui's
 * NewChannelDialog note: Radix portals yield no static markup). */
export function validationIssues(values: FormValues): readonly string[] {
  const issues: string[] = [];
  if (values.name.trim() === "") issues.push("Name is required.");
  if (values.body.trim() === "") issues.push("Skill body is required.");
  return issues;
}

export function CreateSkillDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** Receives the drafted values; the page owns what (if anything) happens
   * with them. No backend is wired up at this stage. */
  readonly onCreated: (draft: SkillDraft) => void;
}) {
  const [values, setValues] = useState<FormValues>(EMPTY_VALUES);
  const [showIssues, setShowIssues] = useState(false);

  function reset() {
    setValues(EMPTY_VALUES);
    setShowIssues(false);
  }

  function handleOpenChange(next: boolean) {
    if (!next) reset();
    onOpenChange(next);
  }

  function handleFormChange(next: Record<string, unknown>) {
    setValues({
      name: typeof next.name === "string" ? next.name : values.name,
      description: typeof next.description === "string" ? next.description : "",
      body: typeof next.body === "string" ? next.body : values.body,
    });
  }

  const issues = validationIssues(values);

  function handleSubmit() {
    if (issues.length > 0) {
      setShowIssues(true);
      return;
    }
    const draft: SkillDraft = {
      name: values.name.trim(),
      description: values.description.trim(),
      body: values.body.trim(),
    };
    reset();
    onOpenChange(false);
    onCreated(draft);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create skill</DialogTitle>
          <DialogDescription>
            Define a reusable capability an agent can declare and a bench can
            install.
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
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
          <IntakeForm
            fields={FIELDS}
            values={values}
            onChange={handleFormChange}
            idPrefix="create-skill"
          />
        </DialogBody>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => handleOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            onClick={handleSubmit}
            disabled={!intakeFieldsComplete(FIELDS, values)}
          >
            Create skill
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
