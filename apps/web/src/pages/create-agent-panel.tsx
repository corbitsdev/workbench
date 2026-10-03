// No drafting assist or per-agent model/skills pin: the routes that backed
// those were removed from the hub.

import { Button, IntakeForm, SelectionCheckbox, Textarea } from "@corbits/react-ui";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@corbits/react-ui/ui/dialog";
import type { IntakeField } from "@corbits/react-ui";
import { useState } from "react";

import { ApiQueryError } from "@/lib/api-query";

import type { DeployedAgent } from "../agent-deploy";
import { useTenantRoles } from "../agent-roles-query";
import { useDeployAgentMutation } from "../agents-api";
import { useMcpServers } from "../tools/mcp-servers-query";
import "./create-agent-panel.css";

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
  // definition binding plus a use requirement, the same as Worker's Exa.
  const [selectedHandles, setSelectedHandles] = useState<readonly string[]>([]);
  // Role names checked below, out of this workbench's roles — each is
  // resolved to the workbench's role id and assigned to the agent once it
  // deploys.
  const [selectedRoles, setSelectedRoles] = useState<readonly string[]>([]);
  const deploy = useDeployAgentMutation(tenantId);
  const catalog = useMcpServers(tenantId);
  const roles = useTenantRoles(tenantId);

  function toggleHandle(handle: string) {
    setSelectedHandles((current) =>
      current.includes(handle) ? current.filter((h) => h !== handle) : [...current, handle],
    );
  }

  function toggleRole(name: string) {
    setSelectedRoles((current) =>
      current.includes(name) ? current.filter((role) => role !== name) : [...current, name],
    );
  }

  function reset() {
    setValues(EMPTY_VALUES);
    setSystemPrompt("");
    setSelectedHandles([]);
    setSelectedRoles([]);
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
        : roles.kind === "loading"
          ? "Roles are still loading."
          : roles.kind === "error"
            ? "Roles failed to load."
            : roles.kind === "unauthenticated"
              ? "Sign in again to deploy."
              : null;

  function handleSubmit() {
    if (blocked !== null) return;
    deploy.mutate(
      {
        name: values.name.trim(),
        systemPrompt: systemPrompt.trim(),
        ...(selectedHandles.length > 0 ? { mcpHandles: selectedHandles } : {}),
        ...(selectedRoles.length > 0 ? { roles: selectedRoles } : {}),
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
            <p className="page-error-inline" role="alert">
              {submitError.message}
              {submitError.refId !== undefined ? (
                <>
                  <br />
                  <span className="page-meta-plain">Reference: {submitError.refId}</span>
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
              className="code-textarea code-textarea-canvas"
              value={systemPrompt}
              onChange={(event) => setSystemPrompt(event.target.value)}
              placeholder="You are..."
              disabled={deploy.isPending}
              rows={6}
            />
          </label>

          <div className="create-agent-servers">
            <fieldset disabled={deploy.isPending}>
              <legend className="create-agent-quiet-field">
                <span>MCP servers</span>
              </legend>
              <p className="page-meta">
                The workspace catalog — checked servers are bound into this agent like your
                worker&apos;s Exa, ask-gated except read-only tools.
              </p>
              {catalog.kind === "loading" ? (
                <p className="page-meta">Loading workspace servers…</p>
              ) : catalog.kind === "ready" && catalog.data.length === 0 ? (
                <p className="page-meta">
                  No MCP servers in this workspace yet — add them on the Tools page.
                </p>
              ) : catalog.kind === "ready" ? (
                <ul className="create-agent-server-list">
                  {catalog.data.map((server) => (
                    <li key={server.credentialId} className="inline-row">
                      <SelectionCheckbox
                        checked={selectedHandles.includes(server.handle)}
                        onToggle={() => toggleHandle(server.handle)}
                        rowLabel={server.name}
                        ariaLabel={`Bind the ${server.name} MCP server`}
                      />
                      <span className="create-agent-server-name">{server.name}</span>
                      <span className="page-meta">{server.handle}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="page-meta">
                  Couldn&apos;t load the workspace catalog — the agent will deploy without MCP
                  servers.
                </p>
              )}
            </fieldset>
            <fieldset disabled={deploy.isPending}>
              <legend className="create-agent-quiet-field">
                <span>Roles</span>
              </legend>
              <p className="page-meta">
                This workbench&apos;s roles — checked roles are assigned to this agent once it
                deploys.
              </p>
              {roles.kind === "loading" ? (
                <p className="page-meta">Loading workbench roles…</p>
              ) : roles.kind === "ready" && roles.data.length === 0 ? (
                <p className="page-meta">No roles in this workbench yet.</p>
              ) : roles.kind === "ready" ? (
                <ul className="create-agent-server-list">
                  {roles.data.map((role) => (
                    <li key={role.id} className="inline-row">
                      <SelectionCheckbox
                        checked={selectedRoles.includes(role.name)}
                        onToggle={() => toggleRole(role.name)}
                        rowLabel={role.name}
                        ariaLabel={`Assign the ${role.name} role`}
                      />
                      <span className="create-agent-server-name">{role.name}</span>
                    </li>
                  ))}
                </ul>
              ) : roles.kind === "error" ? (
                <p className="page-meta">
                  Couldn&apos;t load the workbench&apos;s roles — deploying is blocked until they
                  load.{" "}
                  <Button type="button" variant="outline" onClick={() => roles.retry()}>
                    Retry
                  </Button>
                </p>
              ) : (
                <p className="page-meta">Sign in again to see this workbench&apos;s roles.</p>
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
