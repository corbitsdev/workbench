// The create-skill form: identity (name, description) and the skill
// body itself (the instructions/tools text). Submitting hands the
// values to `onSubmit`, which the Skills page turns directly into a
// native `kind:"skill"` asset write in the workbench's registry
// (`../skills-api.ts`) — there is no intermediate draft. A rejection
// from that call (a name conflict, or SKILL.md frontmatter the registry
// refuses) surfaces inline here rather than closing the dialog, so the
// person never loses what they typed.
//
// The name field is bound by the registry's own rule — lowercase
// letters, digits, and hyphens — because that is what a SKILL.md's
// frontmatter must carry. Rejecting it here beats a server error after
// the person has typed a whole skill body.
//
// CL-6355: the same form doubles as the edit surface — `mode="edit"` seeds
// it from `initialValues` and locks the name field (a skill's name is its
// identity; renaming means creating a new one). No second editor
// component: `SkillDetailView`'s "Edit" affordance opens this dialog with
// `mode="edit"` rather than duplicating the form.

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

const NAME_FIELD: IntakeField = {
  name: "name",
  label: "Name",
  type: "text",
  required: true,
  placeholder: "summarize-transcript",
  help: "Lowercase letters, digits, and hyphens — this becomes the skill's name in the registry.",
};

const DESCRIPTION_AND_BODY_FIELDS: readonly IntakeField[] = [
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

const CREATE_FIELDS: readonly IntakeField[] = [
  NAME_FIELD,
  ...DESCRIPTION_AND_BODY_FIELDS,
];

/** Edit mode drops the name field entirely rather than disabling it — a
 * skill's name is its identity, not an editable property; renaming means
 * creating a differently-named skill. The dialog shows it as static text
 * instead (see `DialogDescription` below). */
const EDIT_FIELDS: readonly IntakeField[] = DESCRIPTION_AND_BODY_FIELDS;

/** Every reason a submission is not yet valid, in plain language — never
 * a generic "invalid form". Exported so the create flow can be proven
 * without SSR-rendering the portal-based dialog (Radix portals yield no
 * static markup). `mode="edit"` skips name validation — the field isn't
 * shown, and the value carried through unchanged is already a valid name. */
export function validationIssues(
  values: FormValues,
  mode: "create" | "edit" = "create",
): readonly string[] {
  const issues: string[] = [];
  if (mode === "edit") {
    if (values.description.trim() === "")
      issues.push("Description is required.");
    if (values.body.trim() === "") issues.push("Skill body is required.");
    return issues;
  }
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
  onSubmit,
  mode = "create",
  initialValues,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** Writes the skill to the registry — `createSkill` in create mode,
   * `updateSkill` (a new version) in edit mode. A rejection's message is
   * shown inline and the form is left as typed. */
  readonly onSubmit: (input: SkillCreateInput) => Promise<void>;
  readonly mode?: "create" | "edit";
  /** Required in edit mode: seeds the form with the skill being edited. */
  readonly initialValues?: SkillCreateInput;
}) {
  const startingValues = initialValues ?? EMPTY_VALUES;
  const [values, setValues] = useState<FormValues>(startingValues);
  const [showIssues, setShowIssues] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function reset() {
    setValues(startingValues);
    setShowIssues(false);
    setServerError(null);
  }

  function handleOpenChange(next: boolean) {
    if (next) setValues(startingValues);
    else reset();
    onOpenChange(next);
  }

  function handleFormChange(next: Record<string, unknown>) {
    setValues({
      name: typeof next.name === "string" ? next.name : values.name,
      description: typeof next.description === "string" ? next.description : "",
      body: typeof next.body === "string" ? next.body : values.body,
    });
  }

  const fields = mode === "edit" ? EDIT_FIELDS : CREATE_FIELDS;
  const issues = validationIssues(values, mode);

  async function handleSubmit() {
    if (issues.length > 0) {
      setShowIssues(true);
      return;
    }
    setServerError(null);
    setSubmitting(true);
    try {
      await onSubmit({
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
          <DialogTitle>
            {mode === "edit" ? `Edit ${values.name}` : "Create skill"}
          </DialogTitle>
          <DialogDescription>
            {mode === "edit"
              ? "Saving publishes a new version — the version it replaces stays in history and can be restored."
              : "Define a reusable capability an agent can declare and this workbench can share."}
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
            fields={fields}
            values={values}
            onChange={handleFormChange}
            idPrefix={mode === "edit" ? "edit-skill" : "create-skill"}
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
            disabled={submitting || !intakeFieldsComplete(fields, values)}
          >
            {mode === "edit" ? "Save" : "Create skill"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
