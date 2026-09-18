// A new workbench is a child tenant plus the agents you put in it. This
// screen is the prompt box: say what you want and hit Enter, or open an
// empty room and add people and agents as you go.

import { Button, toast } from "@corbits/react-ui";
import { PaperPlaneRight } from "@/lib/icons";
import { CHAT_STRINGS, WorkbenchLoadingState } from "@/chat";
import { useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { reportError } from "@corbits/error-sink";

import { useBench } from "../bench-context";
import { chatKeys } from "../chat-path";
import { createWorkbench, WorkbenchCreateError } from "../workbench-create";
import { useNavigate } from "../navigation";
import { StageTopBar } from "../shell/stage-top-bar";
import { workbenchPath } from "../workbench-path";

const GENERIC_CREATE_FAILURE = "Something went wrong creating this workbench. Try again.";

/** Allow-lists what is safe to show verbatim: only the authored
 * stage copy, never a raw request path or schema summary. */
export function describeWorkbenchCreateFailure(cause: unknown, refId?: string): string {
  if (!(cause instanceof WorkbenchCreateError)) return GENERIC_CREATE_FAILURE;
  const message =
    cause.stage === "opening-message"
      ? "Workbench created, but we couldn't send the opening message. Try again from the room."
      : cause.stage === "deploy"
        ? "Workbench created, but its agent couldn't be deployed into it. Try again from the room."
        : GENERIC_CREATE_FAILURE;
  return refId === undefined ? message : `${message} Reference: ${refId}`;
}

const PROMPT_PLACEHOLDER = "What do you want your Workbench to do?";

/** A room's name is its opening ask, trimmed — an empty room is just
 * "Workbench" until it is renamed. */
function workbenchName(prompt: string): string {
  const trimmed = prompt.trim();
  return trimmed === "" ? "Workbench" : trimmed.slice(0, 60);
}

export function NewWorkbenchPickerRoute() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { selectedTenantId } = useBench();
  const [prompt, setPrompt] = useState("");
  const promptRef = useRef<HTMLTextAreaElement | null>(null);

  const create = useMutation({
    mutationFn: ({
      benchTenantId,
      openingMessage,
    }: {
      readonly benchTenantId: string;
      readonly openingMessage: string | undefined;
    }) =>
      createWorkbench({
        benchTenantId,
        name: workbenchName(openingMessage ?? ""),
        ...(openingMessage !== undefined ? { openingMessage } : {}),
      }),
    onSuccess: (tenantId, variables) => {
      void queryClient.invalidateQueries({
        queryKey: chatKeys.childTenants(variables.benchTenantId),
      });
      navigate(workbenchPath(tenantId));
    },
    onError: (cause: unknown) => {
      const refId = reportError(cause, {
        operation: "workbench_create",
        ...(selectedTenantId !== null ? { tenantId: selectedTenantId } : {}),
      });
      toast(describeWorkbenchCreateFailure(cause, refId));
    },
  });

  function startCreate(openingMessage?: string) {
    if (selectedTenantId === null || create.isPending) return;
    create.mutate({
      benchTenantId: selectedTenantId,
      ...(openingMessage !== undefined ? { openingMessage } : { openingMessage: undefined }),
    });
  }

  function handlePromptSubmit() {
    const trimmed = prompt.trim();
    if (trimmed === "") return;
    startCreate(trimmed);
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <StageTopBar
        crumbs={[{ label: CHAT_STRINGS.newWorkbenchAction }]}
        actions={
          <Button type="button" variant="ghost" size="sm" onClick={() => navigate("/")}>
            Cancel
          </Button>
        }
      />
      <div className="new-workbench-picker">
        {create.isPending ? (
          // `delayMs={0}`: this is a genuine wait the instant the person
          // hits Enter, so the default hold-back only bought a blank pane.
          <WorkbenchLoadingState delayMs={0} title="Setting up your workbench…" />
        ) : (
          <>
            <h3>What do you want your Workbench to do?</h3>
            <p className="new-workbench-picker-sub">
              Tell it what you&apos;re trying to get done. Takes about ten seconds.
            </p>

            <form
              className="new-workbench-prompt"
              onSubmit={(event) => {
                event.preventDefault();
                handlePromptSubmit();
              }}
            >
              <div className="new-workbench-prompt-main">
                <textarea
                  ref={promptRef}
                  className="new-workbench-prompt-input"
                  placeholder={PROMPT_PLACEHOLDER}
                  value={prompt}
                  rows={2}
                  onChange={(event) => setPrompt(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      handlePromptSubmit();
                    }
                  }}
                />
                <div className="new-workbench-prompt-examples" aria-label="Try an example">
                  <span>Try</span>
                  {[
                    "Review every PR on faremeter/interchange",
                    "Vet Northwind Traders before we sign",
                    "Summarize what shipped each Friday",
                  ].map((example) => (
                    <button
                      key={example}
                      type="button"
                      aria-pressed={prompt === example}
                      className={prompt === example ? "is-selected" : undefined}
                      onClick={() => setPrompt(example)}
                    >
                      {example}
                    </button>
                  ))}
                </div>
              </div>
              <div className="new-workbench-prompt-actions">
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

            <button
              type="button"
              className="new-workbench-empty-channel"
              disabled={create.isPending || selectedTenantId === null}
              onClick={() => startCreate()}
            >
              Or <span>just open an empty channel</span> — nobody is in it yet, add people and
              agents as you go.
            </button>
          </>
        )}
      </div>
    </div>
  );
}
