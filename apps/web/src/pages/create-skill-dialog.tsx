// The create-skill dialog: paste a skill's fields directly, or upload a
// `SKILL.md` file and let the registry parse them out. Submitting hands
// the result to `onSubmit`, which the Skills page turns directly into a
// native `kind:"skill"` asset write in the workbench's registry
// (`../skills-api.ts`) — there is no intermediate draft, and both modes
// converge on the same registry `create`. A rejection from that call (a
// name conflict, or SKILL.md frontmatter the registry refuses) surfaces
// inline here rather than closing the dialog, so the person never loses
// what they typed or which file they picked.
//
// The name field is bound by the registry's own rule — lowercase
// letters, digits, and hyphens — because that is what a SKILL.md's
// frontmatter must carry. Rejecting it here beats a server error after
// the person has typed a whole skill body.
//
// A skill is one `SKILL.md`, not a bundle: the registry stores a single
// file per skill asset, so upload is deliberately single-file — no
// folders, no zips, no attachments to half-support.
//
// Creation only. Editing an existing skill happens on its own page
// (`skill-detail-page.tsx`, CL-6416), where a save is reviewed as a diff
// before it publishes a new version — this dialog has no edit mode to
// duplicate that flow.

import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  FileInput,
  IntakeForm,
  Tabs,
  intakeFieldsComplete,
} from "@corbits/react-ui";
import type { IntakeField } from "@corbits/react-ui";
import { useState } from "react";

export type SkillCreateInput =
  | {
      readonly kind: "fields";
      readonly name: string;
      readonly description: string;
      readonly body: string;
    }
  | {
      readonly kind: "file";
      /** The uploaded file's raw text — the registry parses it with the
       * same `parseSkillMd` it reads a skill back with. */
      readonly source: string;
    };

type Mode = "paste" | "upload";

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

const FIELDS: readonly IntakeField[] = [
  NAME_FIELD,
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
  onSubmit,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** Writes the skill to the registry. A rejection's message is shown
   * inline and the form is left as typed. */
  readonly onSubmit: (input: SkillCreateInput) => Promise<void>;
}) {
  const [mode, setMode] = useState<Mode>("paste");
  const [values, setValues] = useState<FormValues>(EMPTY_VALUES);
  const [file, setFile] = useState<File | null>(null);
  const [showIssues, setShowIssues] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function reset() {
    setMode("paste");
    setValues(EMPTY_VALUES);
    setFile(null);
    setShowIssues(false);
    setServerError(null);
  }

  function handleOpenChange(next: boolean) {
    reset();
    onOpenChange(next);
  }

  function handleModeChange(next: Mode) {
    setMode(next);
    setShowIssues(false);
    setServerError(null);
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
    if (mode === "paste" && issues.length > 0) {
      setShowIssues(true);
      return;
    }
    if (mode === "upload" && file === null) {
      setShowIssues(true);
      return;
    }
    setServerError(null);
    setSubmitting(true);
    try {
      if (mode === "upload" && file !== null) {
        await onSubmit({ kind: "file", source: await file.text() });
      } else {
        await onSubmit({
          kind: "fields",
          name: values.name.trim(),
          description: values.description.trim(),
          body: values.body.trim(),
        });
      }
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
          {serverError !== null && (
            <p className="mb-3 text-sm text-destructive" role="alert">
              {serverError}
            </p>
          )}
          <Tabs
            tabs={[
              { id: "paste", label: "Paste" },
              { id: "upload", label: "Upload" },
            ]}
            active={mode}
            onChange={handleModeChange}
            label="Skill source"
            variant="enclosed"
          >
            {(active) =>
              active === "paste" ? (
                <>
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
                </>
              ) : (
                <>
                  {showIssues && file === null && (
                    <p className="mb-3 text-sm text-destructive" role="alert">
                      Choose a SKILL.md file to upload.
                    </p>
                  )}
                  <FileInput
                    label="Upload SKILL.md"
                    hint="A Markdown file with YAML frontmatter — name and description — followed by the skill's instructions. One file per skill; folders and attachments aren't supported."
                    accept=".md,text/markdown"
                    disabled={submitting}
                    onFiles={(files) => setFile(files[0] ?? null)}
                  />
                  {file !== null && (
                    <p className="mt-2 text-sm text-muted-foreground">
                      {file.name} selected
                    </p>
                  )}
                </>
              )
            }
          </Tabs>
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
            disabled={
              submitting ||
              (mode === "paste"
                ? !intakeFieldsComplete(FIELDS, values)
                : file === null)
            }
          >
            Create skill
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
