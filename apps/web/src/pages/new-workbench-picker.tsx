// A new workbench starts from one message: creating it deploys its agent and
// posts the message so the worker starts.

import { toast } from "@corbits/react-ui/ui/toast";
import { Button, SelectionCheckbox } from "@corbits/react-ui";
import { WorkbenchLoadingState } from "@/chat";
import { Composer } from "@/chat/composer";
import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { reportError } from "@corbits/error-sink";

import { useBench } from "../bench-context";
import { workbenchKeys } from "../chat-path";
import { NEW_WORKBENCH_TITLE, titleFromFirstMessage } from "@/auto-workbench-title";
import { useTenantRoles } from "../agent-roles-query";
import { createWorkbench, WorkbenchCreateError } from "../workbench-create";
import { useNavigate } from "../navigation";
import { ProviderSkipBanner } from "../provider-skip-banner";
import { StageTopBar } from "../shell/stage-top-bar";
import { workbenchPath } from "../workbench-path";
import "./new-workbench.css";

const GENERIC_CREATE_FAILURE = "Something went wrong creating this workbench. Try again.";

/** Allow-lists what is safe to show verbatim: only the authored
 * stage copy, never a raw request path or schema summary. */
export function describeWorkbenchCreateFailure(cause: unknown, refId?: string): string {
  if (!(cause instanceof WorkbenchCreateError)) return GENERIC_CREATE_FAILURE;
  const message =
    cause.stage === "deploy"
      ? "Workbench created, but its agent couldn't be deployed into it. Try again from the workbench."
      : cause.stage === "roles"
        ? "Workbench created, but its agent's roles couldn't be assigned yet. Open the workbench so its agent starts, then assign roles in Settings."
        : GENERIC_CREATE_FAILURE;
  return refId === undefined ? message : `${message} Reference: ${refId}`;
}

export function NewWorkbenchPickerRoute() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { selectedTenantId } = useBench();
  // Role names, resolved against the new workbench's seeded system roles at
  // create time — so only this workspace's system roles are offered here.
  const roles = useTenantRoles(selectedTenantId);
  const systemRoles = roles.kind === "ready" ? roles.data.filter((role) => role.isSystem) : [];
  const [selectedRoles, setSelectedRoles] = useState<readonly string[]>([]);

  function toggleRole(name: string) {
    setSelectedRoles((current) =>
      current.includes(name) ? current.filter((role) => role !== name) : [...current, name],
    );
  }

  // Autofocus keeps the field quiet; the ring appears once Tab is used.
  const [keyboard, setKeyboard] = useState(false);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Tab") setKeyboard(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const create = useMutation({
    mutationFn: ({
      benchTenantId,
      openingMessage,
      roles,
    }: {
      readonly benchTenantId: string;
      readonly openingMessage: string;
      readonly roles: readonly string[];
    }) =>
      createWorkbench({
        benchTenantId,
        name: titleFromFirstMessage(openingMessage) ?? NEW_WORKBENCH_TITLE,
        openingMessage,
        ...(roles.length > 0 ? { roles } : {}),
      }),
    onSuccess: (tenantId, variables) => {
      void queryClient.invalidateQueries({
        queryKey: workbenchKeys.childTenants(variables.benchTenantId),
      });
      navigate(workbenchPath(tenantId));
    },
    onError: (cause: unknown, variables) => {
      const refId = reportError(cause, {
        operation: "workbench_create",
        ...(selectedTenantId !== null ? { tenantId: selectedTenantId } : {}),
      });
      toast(describeWorkbenchCreateFailure(cause, refId));
      // The workbench exists once a later stage fails; the toast says to retry
      // from the workbench, so go there.
      if (cause instanceof WorkbenchCreateError && cause.tenantId !== undefined) {
        void queryClient.invalidateQueries({
          queryKey: workbenchKeys.childTenants(variables.benchTenantId),
        });
        navigate(workbenchPath(cause.tenantId));
      }
    },
  });

  function submit(text: string) {
    if (selectedTenantId === null || roles.kind !== "ready" || create.isPending) return;
    create.mutate({ benchTenantId: selectedTenantId, openingMessage: text, roles: selectedRoles });
  }

  // The roles read gates the composer: submitting before the options load
  // (or after they fail) would create the workbench without an informed
  // choice, the silent fallback role assignment forbids.
  const composerDisabled = selectedTenantId === null || roles.kind !== "ready";

  return (
    <div className="page-frame">
      <StageTopBar crumbs={[{ label: "New" }]} />
      <div className="new-wrap" data-keyboard={keyboard ? "" : undefined}>
        {create.isPending ? (
          // `delayMs={0}`: a genuine wait the instant the person sends.
          <WorkbenchLoadingState delayMs={0} title="Setting up your workbench…" />
        ) : (
          <>
            <ProviderSkipBanner />
            <h1 className="new-title">What should we work on?</h1>
            <fieldset className="new-roles" disabled={create.isPending}>
              <legend className="page-meta">
                <span>Roles for this workbench&apos;s agent</span>
              </legend>
              {roles.kind === "loading" ? (
                <p className="page-meta">Loading workspace roles…</p>
              ) : roles.kind === "ready" && systemRoles.length === 0 ? (
                <p className="page-meta">No system roles in this workspace yet.</p>
              ) : roles.kind === "ready" ? (
                <>
                  <p className="page-meta">
                    System roles apply to every workbench; custom roles stay in this workspace.
                  </p>
                  <ul className="new-roles-list">
                    {systemRoles.map((role) => (
                      <li key={role.id} className="inline-row">
                        <SelectionCheckbox
                          checked={selectedRoles.includes(role.name)}
                          onToggle={() => toggleRole(role.name)}
                          rowLabel={role.name}
                          ariaLabel={`Assign the ${role.name} role`}
                        />
                        <span className="new-roles-name">{role.name}</span>
                      </li>
                    ))}
                  </ul>
                </>
              ) : roles.kind === "error" ? (
                <p className="page-meta">
                  Couldn&apos;t load the workspace roles — creating a workbench is blocked until
                  they load.{" "}
                  <Button type="button" variant="outline" onClick={() => roles.retry()}>
                    Retry
                  </Button>
                </p>
              ) : (
                <p className="page-meta">
                  Sign in again to see this workspace&apos;s roles and start a workbench.
                </p>
              )}
            </fieldset>
            <Composer
              placeholder="Describe the job — your co-worker sets up the rest"
              busy={false}
              disabled={composerDisabled}
              autoFocus
              sendLabel="Start this workbench"
              voiceUnavailable="Voice starts inside a workbench"
              onSend={submit}
            />
          </>
        )}
      </div>
    </div>
  );
}
