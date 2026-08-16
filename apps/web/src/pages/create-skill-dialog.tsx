// The create-skill form: identity (name, description) and the skill
// body itself (the instructions/tools text). Submitting hands the
// values to `onCreate`, which the Skills section turns directly into a
// native `kind:"skill"` asset in the workbench's registry
// (`../skills-api.ts`) — there is no intermediate draft. A rejection
// from that call (a name conflict, or SKILL.md frontmatter the registry
// refuses) surfaces inline here rather than closing the dialog, so the
// person never loses what they typed.
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

export type SkillCreateInput = {
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
 * without SSR-rendering the portal-based dialog (Radix portals yield no
 * static markup). */
export function validationIssues(values: FormValues): readonly string[] {
  const issues: string[] = [];
  const name = values.name.trim();
  if (name === "") {
    issues.push("Name is required.");
  } else if (!SKILL_NAME_PATTERN.test(name)) {
    issues.push(
      "Name must be lowercase letters, digits, and hyphens — no whitespace or capitals.",
    );
  } else if (name.length > 64) {
    issues.push("Name must be at most 64 characters.");
  }
  if (values.description.trim() === "") issues.push("Description is required.");
  if (values.body.trim() === "") issues.push("Skill body is required.");
  return issues;
}

export function CreateSkillDialog({
  open,
  onOpenChange,
  onCreate,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** Creates the skill directly on the registry. A rejection's message is
   * shown inline and the form is left as typed. */
  readonly onCreate: (input: SkillCreateInput) => Promise<void>;
}) {
  const [values, setValues] = useState<FormValues>(EMPTY_VALUES);
  const [showIssues, setShowIssues] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function reset() {
    setValues(EMPTY_VALUES);
    setShowIssues(false);
    setServerError(null);
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

  async function handleSubmit() {
    if (issues.length > 0) {
      setShowIssues(true);
      return;
    }
    setServerError(null);
    setSubmitting(true);
    try {
      await onCreate({
        name: values.name.trim(),
        description: values.description.trim(),
        body: values.body.trim(),
      });
      reset();
    } catch (cause) {
      setServerError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSubmitting(false);
    }
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
          {serverError !== null && (
            <p className="mb-3 text-sm text-destructive" role="alert">
              {serverError}
            </p>
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
            onClick={() => void handleSubmit()}
            disabled={submitting || !intakeFieldsComplete(FIELDS, values)}
          >
            Create skill
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
