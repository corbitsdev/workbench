// The agent-create panel: name + system prompt, deployed through the stock
// workflow-deploy path (`../agent-deploy.ts`) the same way Myra deploys
// herself. There is no drafting assist and no per-agent model/skills pin
// here — the routes that backed those were removed from the hub; the
// agent's model resolves from the tenant's existing inference offering,
// exactly as Myra's own deploy does.

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
  Textarea,
} from "@corbits/react-ui";
import type { IntakeField } from "@corbits/react-ui";
import { useState } from "react";

import { ApiQueryError } from "@/lib/api-query";

import type { DeployedAgent } from "../agent-deploy";
import { useDeployAgentMutation } from "../agents-api";

function submitErrorFromCause(
  cause: unknown,
  fallback: string,
): { readonly message: string; readonly refId?: string } {
  if (!(cause instanceof ApiQueryError)) {
    return { message: cause instanceof Error ? cause.message : fallback };
  }
  return {
    message: cause.message,
    ...(cause.refId !== undefined ? { refId: cause.refId } : {}),
  };
}

const NAME_FIELD: readonly IntakeField[] = [
  {
    name: "name",
    label: "Name",
    type: "text",
    required: true,
    placeholder: "Research Buddy",
  },
];

type FormValues = { readonly name: string };
const EMPTY_VALUES: FormValues = { name: "" };

export function CreateAgentPanel({
  open,
  onOpenChange,
  tenantId,
  onCreated,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly tenantId: string;
  readonly onCreated: (deployment: DeployedAgent) => void;
}) {
  const [values, setValues] = useState<FormValues>(EMPTY_VALUES);
  const [systemPrompt, setSystemPrompt] = useState("");
  const deploy = useDeployAgentMutation(tenantId);

  function reset() {
    setValues(EMPTY_VALUES);
    setSystemPrompt("");
    deploy.reset();
  }

  function handleOpenChange(next: boolean) {
    if (!next) reset();
    onOpenChange(next);
  }

  const blocked =
    values.name.trim() === ""
      ? "Add a name to continue."
      : systemPrompt.trim() === ""
        ? "Write a system prompt to continue."
        : null;

  function handleSubmit() {
    if (blocked !== null) return;
    deploy.mutate(
      { name: values.name.trim(), systemPrompt: systemPrompt.trim() },
      {
        onSuccess: (deployment) => {
          reset();
          onOpenChange(false);
          onCreated(deployment);
        },
      },
    );
  }

  const submitError = deploy.isError
    ? submitErrorFromCause(deploy.error, "Could not deploy this agent.")
    : null;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent side="right" className="create-agent-panel">
        <DialogHeader>
          <DialogTitle>New agent</DialogTitle>
          <DialogDescription>
            A name and a system prompt deploy an agent through this workbench's connected model
            provider.
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          {submitError !== null && (
            <p className="mb-3 text-sm text-destructive" role="alert">
              {submitError.message}
              {submitError.refId !== undefined ? (
                <>
                  <br />
                  <span className="text-xs">Reference: {submitError.refId}</span>
                </>
              ) : null}
            </p>
          )}

          <IntakeForm
            fields={NAME_FIELD}
            values={values}
            onChange={(next) =>
              setValues({ name: typeof next.name === "string" ? next.name : values.name })
            }
            idPrefix="create-agent"
            disabled={deploy.isPending}
          />

          <label className="create-agent-quiet-field">
            <span>System prompt</span>
            <Textarea
              id="create-agent-system-prompt"
              className="bg-background font-mono text-[0.8125rem]"
              value={systemPrompt}
              onChange={(event) => setSystemPrompt(event.target.value)}
              placeholder="You are..."
              disabled={deploy.isPending}
              rows={6}
            />
          </label>

          <div className="mt-3 flex flex-col gap-2">
            <Button
              type="button"
              onClick={handleSubmit}
              disabled={deploy.isPending || blocked !== null}
            >
              {deploy.isPending ? "Deploying…" : (blocked ?? "Deploy")}
            </Button>
          </div>
        </DialogBody>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => handleOpenChange(false)}
            disabled={deploy.isPending}
          >
            Cancel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
