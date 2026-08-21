// Screen 1 of the approved mock (CL-6342): one row list, no card grid, no
// second "or start blank" branch underneath it — "Just start talking" is a
// peer row, not a fallback. A row is always selected on entry (the mock's
// "Code review" default), so the primary button stays enabled the whole
// time. Picking "Code review" instantiates the real template (CL-6344):
// the reviewer roster's agent definitions and the room's own opening
// intro — see `createWorkbenchFromTemplate`'s own doc for exactly what
// that does and doesn't do yet (the GitHub connect card itself is the
// next slice).

import { Button, toast } from "@corbits/react-ui";
import { ChatCircle, GitPullRequest, Plus } from "@corbits/icons";
import {
  ChatApiError,
  describeChatError,
  WorkbenchLoadingState,
} from "@corbits/chat-ui";
import { useState } from "react";
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
  COMING_SOON_ROW,
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

const ROW_ICON: Record<WorkbenchTemplateId, typeof GitPullRequest> = {
  "code-review": GitPullRequest,
  blank: ChatCircle,
};

function ctaLabel(selected: boolean): string {
  return selected ? "Selected" : "Choose";
}

/** The one kind that needs no manifest: an empty room is always
 * something this bench can set up. */
const BLANK_TEMPLATE_ID: WorkbenchTemplateId = "blank";

export function NewWorkbenchPickerRoute() {
  const navigate = useNavigate();
  const { selectedTenantId } = useBench();
  const library = useAPIQuery(
    selectedTenantId === null
      ? ""
      : `/api/tenants/${selectedTenantId}/library/templates`,
    TemplateLibraryPage,
  );
  const [picked, setPicked] = useState<WorkbenchTemplateId | null>(null);
  const [creating, setCreating] = useState(false);
  // Set only when `createWorkbenchFromTemplate` hit the missing-setup-agent
  // precondition *and* a readiness check confirmed the bench genuinely
  // isn't chat-ready yet — never a guess from the error alone, since that
  // precondition is also what a template-that-will-never-exist looks like.
  // Distinct from `creating`'s loader: this is a dead end until setup
  // finishes, not a request in flight.
  const [stillSettingUp, setStillSettingUp] = useState(false);
  const [repoPicker, setRepoPicker] = useState<RepoPickerState | null>(null);

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
  const selectedId =
    picked ?? offeredTemplates[0]?.id ?? WORKBENCH_TEMPLATES[0]?.id ?? "blank";

  const pickGithubRepos: PickGithubRepos = ({
    orgName,
    repos,
    selectedRepoIds,
  }) =>
    new Promise((resolve) => {
      setRepoPicker({ orgName, repos, selectedRepoIds, resolve });
    });

  async function handleCreate() {
    if (selectedTenantId === null || creating) return;
    setCreating(true);
    setStillSettingUp(false);
    try {
      await createWorkbenchFromTemplate(
        selectedTenantId,
        selectedId,
        navigate,
        pickGithubRepos,
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

  return (
    <div className="flex h-full min-h-0 flex-col">
      <StageTopBar
        crumbs={[{ label: "New workbench" }]}
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
            <Button
              type="button"
              variant="outline"
              onClick={() => void handleCreate()}
            >
              Try again
            </Button>
          </div>
        ) : creating ? (
          <WorkbenchLoadingState title="Setting up your workbench…" />
        ) : library.kind === "loading" ? (
          <WorkbenchLoadingState title="Seeing what you can set up here…" />
        ) : (
          <>
            <h3>What should this workbench do?</h3>
            <p className="new-workbench-picker-sub">
              Pick one. You can change your mind later — nothing is locked in.
            </p>

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

            <div
              className="new-workbench-pick-list"
              role="radiogroup"
              aria-label="Workbench kind"
            >
              {offeredTemplates.map((template) => {
                const Icon = ROW_ICON[template.id];
                const selected = template.id === selectedId;
                return (
                  <button
                    key={template.id}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    data-selected={selected ? "true" : undefined}
                    className="new-workbench-pick-row"
                    onClick={() => setPicked(template.id)}
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
                    <span className="new-workbench-pick-cta">
                      {ctaLabel(selected)}
                    </span>
                  </button>
                );
              })}

              {unavailableTemplates.map((template) => {
                const Icon = ROW_ICON[template.id];
                return (
                  <span
                    key={template.id}
                    className="new-workbench-pick-row"
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
                    <span className="new-workbench-pick-cta">Unavailable</span>
                  </span>
                );
              })}

              <span className="new-workbench-pick-row" aria-disabled="true">
                <span className="new-workbench-pick-glyph" aria-hidden="true">
                  <Plus size={16} strokeWidth={1.8} />
                </span>
                <span className="new-workbench-pick-text">
                  <span className="new-workbench-pick-title">
                    {COMING_SOON_ROW.title}
                  </span>
                  <span className="new-workbench-pick-promise">
                    {COMING_SOON_ROW.promise}
                  </span>
                </span>
                <span className="new-workbench-pick-cta">Coming</span>
              </span>
            </div>

            <div className="new-workbench-picker-foot">
              <Button
                type="button"
                onClick={() => void handleCreate()}
                disabled={creating || selectedTenantId === null}
              >
                Create workbench
              </Button>
              <span className="new-workbench-picker-foot-note">
                Takes about ten seconds.
              </span>
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
