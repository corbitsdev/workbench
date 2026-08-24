// CL-6628: flips the picker's hierarchy from "choose a kind, then create"
// to "say what you want, or choose a shortcut" — a prompt box is the
// primary act, with the prefab rows (still CL-6342/CL-6344's real
// instantiation paths) demoted to one-click shortcuts underneath. Typing
// a goal and hitting Enter creates a blank room and hands that text to
// `createWorkbenchFromTemplate` as `firstMessage`, so Myra's first read of
// the room is the person's actual intent rather than a kind label. A
// prefab click still creates immediately — no radio-then-Create
// second step anywhere on this screen.

import { Button, toast } from "@corbits/react-ui";
import {
  ChatCircle,
  GitPullRequest,
  MagnifyingGlass,
  PaperPlaneRight,
} from "@corbits/icons";
import {
  ChatApiError,
  describeChatError,
  WorkbenchLoadingState,
} from "@corbits/chat-ui";
import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { getLogger } from "@corbits/client-log";
import { ApiQueryError, describeApiError } from "@corbits/api-query";

import type { ConnectGithubRepo } from "@corbits/chat-ui";

import { useAPIQuery } from "../api";
import { TemplateLibraryPage } from "../workbench-templates-api";
import { useBench } from "../bench-context";
import {
  createWorkbenchFromTemplate,
  WorkbenchPreconditionError,
  type PickGithubRepos,
} from "../instant-agent-create";
import { fetchAgentReadiness } from "../onboarding";
import { useNavigate } from "../navigation";
import { StageTopBar } from "../shell/stage-top-bar";
import {
  WORKBENCH_TEMPLATES,
  type WorkbenchTemplateId,
} from "../workbench-templates";
import { GithubRepoSelectDialog } from "./github-repo-select-dialog";

const log = getLogger("web.new-workbench-picker");

const GENERIC_CREATE_FAILURE =
  "Something went wrong creating this workbench. Try again.";

/**
 * Allow-lists what's safe to show verbatim, rather than denylisting
 * what to hide — a new error type `createWorkbenchFromTemplate`'s path
 * starts throwing later lands here unrecognized and falls to the
 * generic message, not into the toast raw. Only
 * `WorkbenchPreconditionError` carries authored, always-safe copy
 * ("try again" is a lie for a missing template, so its own message
 * says so instead); `ApiQueryError` and `ChatApiError` both embed raw
 * request paths and schema summaries in `.message` and must go through
 * their own describer, never shown directly.
 */
export function describeWorkbenchCreateFailure(cause: unknown): string {
  if (cause instanceof WorkbenchPreconditionError) return cause.message;
  if (cause instanceof ApiQueryError) {
    return describeApiError(cause, "creating this workbench");
  }
  if (cause instanceof ChatApiError) {
    return describeChatError(cause, GENERIC_CREATE_FAILURE);
  }
  return GENERIC_CREATE_FAILURE;
}

type RepoPickerState = {
  readonly orgName: string;
  readonly repos: readonly ConnectGithubRepo[];
  readonly selectedRepoIds: readonly string[];
  readonly resolve: (repoIds: readonly string[] | null) => void;
};

const CARD_ICON: Record<WorkbenchTemplateId, typeof GitPullRequest> = {
  "code-review": GitPullRequest,
  "due-diligence": MagnifyingGlass,
  blank: ChatCircle,
};

/** The one kind that needs no manifest: an empty room is always
 * something this bench can set up. */
const BLANK_TEMPLATE_ID: WorkbenchTemplateId = "blank";

const PROMPT_PLACEHOLDER = "What do you want your Workbench to do?";

export function NewWorkbenchPickerRoute() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { selectedTenantId } = useBench();
  const library = useAPIQuery(
    selectedTenantId === null
      ? ""
      : `/api/tenants/${selectedTenantId}/library/templates`,
    TemplateLibraryPage,
  );
  const [prompt, setPrompt] = useState("");
  const [creating, setCreating] = useState(false);
  // Set only when `createWorkbenchFromTemplate` hit the missing-setup-agent
  // precondition *and* a readiness check confirmed the bench genuinely
  // isn't chat-ready yet — never a guess from the error alone, since that
  // precondition is also what a template-that-will-never-exist looks like.
  // Distinct from `creating`'s loader: this is a dead end until setup
  // finishes, not a request in flight.
  const [stillSettingUp, setStillSettingUp] = useState(false);
  const [repoPicker, setRepoPicker] = useState<RepoPickerState | null>(null);
  const promptRef = useRef<HTMLTextAreaElement | null>(null);
  // The last attempted create, so "Try again" (both the still-setting-up
  // dead end and a plain toast-and-retry) replays the exact same request
  // rather than silently falling back to blank.
  const lastAttemptRef = useRef<{
    readonly templateId: WorkbenchTemplateId;
    readonly firstMessage: string | undefined;
  } | null>(null);

  // The prompt box only exists in the DOM once the library read settles
  // and neither dead-end state is showing — an unconditional mount-time
  // effect would fire while that branch renders `WorkbenchLoadingState`
  // instead, before `promptRef` has anything to focus. Re-running on
  // `showingPrompt` catches the moment the textarea actually mounts.
  const showingPrompt =
    !stillSettingUp && !creating && library.kind !== "loading";
  useEffect(() => {
    if (showingPrompt) promptRef.current?.focus();
  }, [showingPrompt]);

  // What this bench's library can actually serve (CL-6458). A kind whose
  // manifest the library doesn't hold is shown as not set up rather than
  // offered and then dead-ended on a 404 at create time.
  const servedTemplateIds =
    library.kind === "ready"
      ? new Set(library.data.data.map((entry) => entry.id))
      : new Set<string>();
  const offeredTemplates = WORKBENCH_TEMPLATES.filter(
    (template) =>
      template.id === BLANK_TEMPLATE_ID || servedTemplateIds.has(template.id),
  );
  const unavailableTemplates = WORKBENCH_TEMPLATES.filter(
    (template) => !offeredTemplates.includes(template),
  );

  const pickGithubRepos: PickGithubRepos = ({
    orgName,
    repos,
    selectedRepoIds,
  }) =>
    new Promise((resolve) => {
      setRepoPicker({ orgName, repos, selectedRepoIds, resolve });
    });

  async function handleCreate(
    templateId: WorkbenchTemplateId,
    firstMessage?: string,
  ) {
    if (selectedTenantId === null || creating) return;
    lastAttemptRef.current = { templateId, firstMessage };
    setCreating(true);
    setStillSettingUp(false);
    try {
      await createWorkbenchFromTemplate(
        selectedTenantId,
        templateId,
        navigate,
        queryClient,
        pickGithubRepos,
        firstMessage,
      );
    } catch (cause) {
      // The missing-setup-agent precondition reads identically whether
      // this bench's default agents never finished deploying (CL-6457's
      // background drain is still running, or never started without a
      // credential) or something is genuinely broken. Only a readiness
      // check tells those apart — never assume from the throw alone.
      if (
        cause instanceof WorkbenchPreconditionError &&
        cause.kind === "setup-agent-missing"
      ) {
        const readiness = await fetchAgentReadiness();
        if (readiness.kind !== "ready" && readiness.kind !== "chat-ready") {
          setCreating(false);
          setStillSettingUp(true);
          return;
        }
      }
      log.error("Couldn't create the workbench", {
        message: cause instanceof Error ? cause.message : String(cause),
        status:
          cause instanceof ApiQueryError || cause instanceof ChatApiError
            ? cause.status
            : undefined,
        path: cause instanceof ApiQueryError ? cause.path : undefined,
      });
      toast(describeWorkbenchCreateFailure(cause));
      setCreating(false);
    }
  }

  function retryLastAttempt() {
    const attempt = lastAttemptRef.current;
    if (attempt === null) return;
    void handleCreate(attempt.templateId, attempt.firstMessage);
  }

  function handlePromptSubmit() {
    const trimmed = prompt.trim();
    if (trimmed === "") return;
    void handleCreate(BLANK_TEMPLATE_ID, trimmed);
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <StageTopBar
        crumbs={[{ label: "New room" }]}
        actions={
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => navigate("/")}
          >
            Cancel
          </Button>
        }
      />
      <div className="new-workbench-picker">
        {stillSettingUp ? (
          <div className="new-workbench-picker-not-ready">
            <h3>Still setting up your workbench</h3>
            <p className="new-workbench-picker-sub">
              Your account&apos;s agents are finishing setup in the background.
              This usually takes under a minute — try again in a moment.
            </p>
            <Button type="button" variant="outline" onClick={retryLastAttempt}>
              Try again
            </Button>
          </div>
        ) : creating ? (
          // `delayMs={0}`: we already know this is a genuine wait the
          // instant the person hits Enter or clicks a card, so the default
          // "hold back briefly in case it resolves fast" delay only bought
          // a blank pane here (CL-6623 finding #3) — show the loader
          // outright instead of leaving a gap before it mounts.
          <WorkbenchLoadingState
            delayMs={0}
            title="Setting up your workbench…"
          />
        ) : library.kind === "loading" ? (
          <WorkbenchLoadingState title="Seeing what you can set up here…" />
        ) : (
          <>
            <h3>What do you want your Workbench to do?</h3>
            <p className="new-workbench-picker-sub">
              Tell it what you're trying to get done, or pick one below. Takes
              about ten seconds.
            </p>

            <form
              className="new-workbench-prompt"
              onSubmit={(event) => {
                event.preventDefault();
                handlePromptSubmit();
              }}
            >
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
              <Button
                type="submit"
                size="icon"
                aria-label="Start this workbench"
                disabled={prompt.trim() === "" || selectedTenantId === null}
              >
                <PaperPlaneRight size={16} strokeWidth={1.8} />
              </Button>
            </form>

            {library.kind === "error" ? (
              <p className="new-workbench-picker-sub" role="status">
                Couldn't load what this bench can set up, so only a plain room
                is on offer right now.{" "}
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => library.retry()}
                >
                  Try again
                </Button>
              </p>
            ) : null}

            <div className="new-workbench-prefab-grid">
              {offeredTemplates.map((template) => {
                const Icon = CARD_ICON[template.id];
                return (
                  <button
                    key={template.id}
                    type="button"
                    className="new-workbench-prefab-card"
                    disabled={creating || selectedTenantId === null}
                    onClick={() => void handleCreate(template.id)}
                  >
                    <span
                      className="new-workbench-pick-glyph"
                      aria-hidden="true"
                    >
                      <Icon size={16} strokeWidth={1.8} />
                    </span>
                    <span className="new-workbench-pick-text">
                      <span className="new-workbench-pick-title">
                        {template.title}
                      </span>
                      <span className="new-workbench-pick-promise">
                        {template.promise}
                      </span>
                    </span>
                  </button>
                );
              })}

              {unavailableTemplates.map((template) => {
                const Icon = CARD_ICON[template.id];
                return (
                  <span
                    key={template.id}
                    className="new-workbench-prefab-card"
                    aria-disabled="true"
                  >
                    <span
                      className="new-workbench-pick-glyph"
                      aria-hidden="true"
                    >
                      <Icon size={16} strokeWidth={1.8} />
                    </span>
                    <span className="new-workbench-pick-text">
                      <span className="new-workbench-pick-title">
                        {template.title}
                      </span>
                      <span className="new-workbench-pick-promise">
                        Not set up on this bench yet.
                      </span>
                    </span>
                  </span>
                );
              })}
            </div>
          </>
        )}
      </div>
      {repoPicker !== null ? (
        <GithubRepoSelectDialog
          orgName={repoPicker.orgName}
          repos={repoPicker.repos}
          initialSelectedRepoIds={repoPicker.selectedRepoIds}
          onStartReviewing={(repoIds) => {
            repoPicker.resolve(repoIds);
            setRepoPicker(null);
          }}
          onSkip={() => {
            repoPicker.resolve(null);
            setRepoPicker(null);
          }}
        />
      ) : null}
    </div>
  );
}
