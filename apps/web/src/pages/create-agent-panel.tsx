// No drafting assist or per-agent model/skills pin: the routes that backed
// those were removed from the hub.

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
  SelectionCheckbox,
  Textarea,
} from "@corbits/react-ui";
import type { IntakeField } from "@corbits/react-ui";
import { useState } from "react";

import { ApiQueryError } from "@/lib/api-query";

import type { DeployedAgent } from "../agent-deploy";
import { useDeployAgentMutation } from "../agents-api";
import { useMcpServers } from "../tools/mcp-servers-query";

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
  // Handles checked below, out of the workspace catalog — each becomes a
  // definition binding plus a use requirement, the same as Myra's Exa.
  const [selectedHandles, setSelectedHandles] = useState<readonly string[]>([]);
  const deploy = useDeployAgentMutation(tenantId);
  const catalog = useMcpServers(tenantId);

  function toggleHandle(handle: string) {
    setSelectedHandles((current) =>
      current.includes(handle) ? current.filter((h) => h !== handle) : [...current, handle],
    );
  }

  function reset() {
    setValues(EMPTY_VALUES);
    setSystemPrompt("");
    setSelectedHandles([]);
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
      {
        name: values.name.trim(),
        systemPrompt: systemPrompt.trim(),
        ...(selectedHandles.length > 0 ? { mcpHandles: selectedHandles } : {}),
      },
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
            <fieldset disabled={deploy.isPending}>
              <legend className="create-agent-quiet-field">
                <span>MCP servers</span>
              </legend>
              <p className="text-xs text-muted-foreground">
                The workspace catalog — checked servers are bound into this agent like Myra&apos;s
                Exa, ask-gated except read-only tools.
              </p>
              {catalog.kind === "loading" ? (
                <p className="text-xs text-muted-foreground">Loading workspace servers…</p>
              ) : catalog.kind === "ready" && catalog.data.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  No MCP servers in this workspace yet — add them on the Tools page.
                </p>
              ) : catalog.kind === "ready" ? (
                <ul className="mt-1 flex flex-col gap-1">
                  {catalog.data.map((server) => (
                    <li key={server.credentialId} className="flex items-center gap-2">
                      <SelectionCheckbox
                        checked={selectedHandles.includes(server.handle)}
                        onToggle={() => toggleHandle(server.handle)}
                        rowLabel={server.name}
                        ariaLabel={`Bind the ${server.name} MCP server`}
                      />
                      <span className="text-sm">{server.name}</span>
                      <span className="text-xs text-muted-foreground">{server.handle}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-xs text-muted-foreground">
                  Couldn&apos;t load the workspace catalog — the agent will deploy without MCP
                  servers.
                </p>
              )}
            </fieldset>
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
