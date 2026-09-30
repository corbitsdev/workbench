// A new workbench starts from one message: creating it deploys its agent and
// posts the message so the worker starts.

import { Button, toast } from "@corbits/react-ui";
import { PaperPlaneRight } from "@/lib/icons";
import { CHAT_STRINGS, WorkbenchLoadingState } from "@/chat";
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { reportError } from "@corbits/error-sink";

import { useBench } from "../bench-context";
import { workbenchKeys } from "../chat-path";
import { createWorkbench, WorkbenchCreateError } from "../workbench-create";
import { useNavigate } from "../navigation";
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

const SUGGESTIONS = [
  "Review every pull request on a repository",
  "Vet a vendor before we sign",
  "Summarize what shipped each Friday",
];

/** A workbench's name is its opening ask, trimmed. */
function workbenchName(prompt: string): string {
  const trimmed = prompt.trim();
  return trimmed === "" ? "Workbench" : trimmed.slice(0, 60);
}

export function NewWorkbenchPickerRoute() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { selectedTenantId } = useBench();
  const [prompt, setPrompt] = useState("");

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
        name: workbenchName(openingMessage),
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

  function submit() {
    const trimmed = prompt.trim();
    if (trimmed === "" || selectedTenantId === null || create.isPending) return;
    create.mutate({ benchTenantId: selectedTenantId, openingMessage: trimmed });
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <StageTopBar crumbs={[{ label: CHAT_STRINGS.newWorkbenchAction }]} />
      <div className="new-wrap">
        {create.isPending ? (
          // `delayMs={0}`: a genuine wait the instant the person sends.
          <WorkbenchLoadingState delayMs={0} title="Setting up your workbench…" />
        ) : (
          <>
            <h1 className="new-title">What should this workbench do?</h1>
            <form
              className="new-composer"
              onSubmit={(event) => {
                event.preventDefault();
                submit();
              }}
            >
              <textarea
                className="new-composer-input"
                aria-label="What should this workbench do?"
                placeholder="Describe the job. Your co-worker sets up the rest."
                value={prompt}
                rows={3}
                autoFocus
                onChange={(event) => setPrompt(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    submit();
                  }
                }}
              />
              <div className="new-composer-row">
                <Button
                  type="submit"
                  aria-label="Start this workbench"
                  disabled={prompt.trim() === "" || selectedTenantId === null}
                >
                  Start
                  <PaperPlaneRight size={16} strokeWidth={1.8} />
                </Button>
              </div>
            </form>
            <div className="new-suggestions" aria-label="Quick start">
              {SUGGESTIONS.map((suggestion) => (
                <button key={suggestion} type="button" onClick={() => setPrompt(suggestion)}>
                  {suggestion}
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
