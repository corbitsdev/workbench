// A new workbench starts from one message: creating it deploys its agent and
// posts the message so the worker starts.

import { toast } from "@corbits/react-ui/ui/toast";
import { WorkbenchLoadingState } from "@/chat";
import { Composer } from "@/chat/composer";
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { reportError } from "@corbits/error-sink";

import { useBench } from "../bench-context";
import { workbenchKeys } from "../chat-path";
import { NEW_WORKBENCH_TITLE, titleFromFirstMessage } from "@/auto-workbench-title";
import { listWorkbenchTenants, workbenchesQueryKey } from "@/chat/workbench-tenants";
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
      : GENERIC_CREATE_FAILURE;
  return refId === undefined ? message : `${message} Reference: ${refId}`;
}

export function NewWorkbenchPickerRoute() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { selectedTenantId } = useBench();
  // Zero workbenches means this page doubles as the onboarding step that
  // creates the first one — the title says so instead of the generic prompt.
  const workbenches = useQuery({
    queryKey: workbenchesQueryKey(selectedTenantId ?? ""),
    enabled: selectedTenantId !== null,
    queryFn: () => listWorkbenchTenants(selectedTenantId ?? ""),
  });
  const isFirstWorkbench = workbenches.data?.length === 0;

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
    }: {
      readonly benchTenantId: string;
      readonly openingMessage: string;
    }) =>
      createWorkbench({
        benchTenantId,
        name: titleFromFirstMessage(openingMessage) ?? NEW_WORKBENCH_TITLE,
        openingMessage,
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
    if (selectedTenantId === null || create.isPending) return;
    create.mutate({ benchTenantId: selectedTenantId, openingMessage: text });
  }

  const composerDisabled = selectedTenantId === null;

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
            <h1 className="new-title">
              {isFirstWorkbench ? "Create your first workbench" : "What should we work on?"}
            </h1>
            {isFirstWorkbench ? (
              <p className="page-meta new-subtitle">
                A workbench gives the job its own space and co-worker.
              </p>
            ) : null}
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
