// Scoped down to naming the asset only: the stock asset routes accept a
// bare `{ kind, name, displayName }`, with no stock route yet to write a
// skill's SKILL.md content in the same call.
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
  readonly displayName: string;
};

/** Mirrors the native `kind:"skill"` asset name rule — lowercase-kebab. */
const SKILL_NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

const FIELDS: readonly IntakeField[] = [
  {
    name: "name",
    label: "Name",
    type: "text",
    required: true,
    placeholder: "summarize-transcript",
    help: "Lowercase letters, digits, and hyphens — this becomes the skill's name.",
  },
  {
    name: "displayName",
    label: "Display name",
    type: "text",
    required: false,
    placeholder: "Summarize transcript",
  },
];

export function validationIssues(values: SkillCreateInput): readonly string[] {
  const issues: string[] = [];
  const name = values.name.trim();
  if (name === "") {
    issues.push("Name is required.");
  } else if (!SKILL_NAME_PATTERN.test(name)) {
    issues.push("Name must be lowercase letters, digits, and hyphens — no whitespace or capitals.");
  } else if (name.length > 64) {
    issues.push("Name must be at most 64 characters.");
  }
  return issues;
}

const EMPTY_VALUES: SkillCreateInput = { name: "", displayName: "" };

export function CreateSkillDialog({
  open,
  onOpenChange,
  onSubmit,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** Creates the skill asset. A rejection's message is shown inline and
   * the form is left as typed. */
  readonly onSubmit: (input: SkillCreateInput) => Promise<void>;
}) {
  const [values, setValues] = useState<SkillCreateInput>(EMPTY_VALUES);
  const [showIssues, setShowIssues] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function reset() {
    setValues(EMPTY_VALUES);
    setShowIssues(false);
    setServerError(null);
  }

  function handleOpenChange(next: boolean) {
    reset();
    onOpenChange(next);
  }

  function handleFormChange(next: Record<string, unknown>) {
    setValues({
      name: typeof next.name === "string" ? next.name : values.name,
      displayName: typeof next.displayName === "string" ? next.displayName : values.displayName,
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
      await onSubmit({
        name: values.name.trim(),
        displayName: values.displayName.trim(),
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
            Names a new skill asset in this workbench. Its instructions are written separately —
            there is no stock hub route yet to author SKILL.md content in this dialog.
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          {serverError !== null && (
            <p className="mb-3 text-sm text-destructive" role="alert">
              {serverError}
            </p>
          )}
          {showIssues && issues.length > 0 && (
            <ul className="mb-3 list-inside list-disc text-sm text-destructive" role="alert">
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
          <Button type="button" variant="outline" onClick={() => handleOpenChange(false)}>
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
