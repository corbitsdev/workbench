// The create-skill form: identity (name, description) and the skill
// body itself (the instructions/tools text). Submitting hands the
// values to `onDrafted`, which the Skills section turns into a pending
// draft in the workbench's registry (`../skills-api.ts`); a separate
// Publish action is what makes the skill real. The dialog itself owns
// only the form.
//
// The name field is bound by the registry's own rule — lowercase
// letters, digits, and hyphens — because that is what a SKILL.md's
// frontmatter must carry. Rejecting it here beats a server error after
// the person has typed a whole skill body.

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

export type SkillDraftInput = {
  readonly name: string;
  readonly description: string;
  readonly body: string;
};

/** Mirrors `@corbits/skills`' `skillNameSchema` — kebab-case, `<=64`. */
const SKILL_NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

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
    placeholder: "summarize-transcript",
    help: "Lowercase letters, digits, and hyphens — this becomes the skill's name in the registry.",
  },
  {
    name: "description",
    label: "Description",
    type: "textarea",
    required: true,
    placeholder: "What this skill does and when to use it",
    help: "Agents see this line — and only this line — when deciding whether to load the skill.",
  },
  {
    name: "body",
    label: "Skill body",
    type: "textarea",
    required: true,
    placeholder: "Instructions, tools, and guardrails this skill packages…",
    help: "The instructions an agent can declare and this workbench can share.",
  },
];

/** Every reason a submission is not yet valid, in plain language — never
 * a generic "invalid form". Exported so the create flow can be proven
 * without SSR-rendering the portal-based dialog (see chat-ui's
 * NewChannelDialog note: Radix portals yield no static markup). */
export function validationIssues(values: FormValues): readonly string[] {
  const issues: string[] = [];
  const name = values.name.trim();
  if (name === "") {
    issues.push("Name is required.");
  } else if (!SKILL_NAME_PATTERN.test(name)) {
    issues.push(
      "Name must be lowercase letters, digits, and hyphens — no spaces or capitals.",
    );
  } else if (name.length > 64) {
    issues.push("Name must be at most 64 characters.");
  } else if (name.startsWith("draft-")) {
    issues.push(
      'Name cannot start with "draft-" — that prefix marks a pending draft.',
    );
  }
  if (values.description.trim() === "") issues.push("Description is required.");
  if (values.body.trim() === "") issues.push("Skill body is required.");
  return issues;
}

export function CreateSkillDialog({
  open,
  onOpenChange,
  onDrafted,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** Receives the authored values; the Skills section turns them into a
   * pending draft on the registry. */
  readonly onDrafted: (draft: SkillDraftInput) => void;
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
    const draft: SkillDraftInput = {
      name: values.name.trim(),
      description: values.description.trim(),
      body: values.body.trim(),
    };
    reset();
    onDrafted(draft);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create skill</DialogTitle>
          <DialogDescription>
            Define a reusable capability an agent can declare and this workbench
            can share.
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
