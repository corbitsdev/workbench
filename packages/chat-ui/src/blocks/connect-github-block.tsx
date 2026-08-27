// The room's first-minute scene card: one `BlockCard` that names the job,
// carries the walkthrough the workbench's own onboarding copy wrote, and
// flips its body between connecting, picking repos, and reviewing --
// inline in the room, never a settings page or a dialog.
// Selection is controlled: like `PollBlockView` never keeps its own tally,
// this view never owns which repos are picked -- it renders what it's given
// and reports toggles upward. It stays pure and props-driven so it can be
// exercised and reviewed without a server; `./connect-github-block-container.tsx`
// is what wires these callbacks to a live `ConnectGithubActions` port
// (CL-6345), the same way `PollBlockView`'s own container wires it to
// `BlockResponseActions`.
//
// The repo row's control is `@corbits/react-ui`'s own `Checkbox` (bare
// mode) rather than a hand-rolled input -- AGENTS.md puts generic controls
// upstream in react-ui, not here. Its corner radius is react-ui's rounded
// default, a visual delta from the mock's flat radius-0 system; the row
// layout around it (name left, open-PR count right) is workbench-specific
// composition and stays local.

import { useEffect, useRef, useState } from "react";
import { Button, Checkbox, Input } from "@corbits/react-ui";
import { Check } from "@corbits/icons";

import { CHAT_STRINGS } from "../strings";
import { BlockCard } from "./block-card";

export type ConnectGithubRepo = {
  readonly id: string;
  readonly name: string;
  readonly openPullRequestCount: number;
};

/** One labelled step of the room's walkthrough, as the workbench's own
 * onboarding copy wrote it — the card never holds step text of its own. */
export type OnboardingSceneStep = {
  readonly title: string;
  readonly why: string;
};

/** The framing every state of this card keeps: the job the room is here
 * to do, the one-line promise under it, and the ordered walkthrough. The
 * card flips its body between states while this header stays put. */
export type OnboardingScene = {
  readonly title: string;
  readonly promise?: string;
  readonly steps?: readonly OnboardingSceneStep[];
  /** Which step of `steps` the person is on now, by position. */
  readonly currentStepIndex: number;
};

/** The walkthrough this card knows how to mark: connect, pick, review.
 * A workbench whose steps read differently still gets its labels
 * rendered — just without a "you're here" marker the positions would
 * only be guessing at. */
const MARKABLE_STEP_COUNT = 3;

/** What the card's body is doing right now, without the scene framing
 * every state shares — the shape a host names when it only cares about
 * the body variant. */
export type ConnectGithubCardBody =
  | {
      readonly kind: "disconnected";
      readonly onConnect: () => void;
      /** Submits a pasted personal access token — the only connect path
       * this repo builds today (CL-6345's PAT-first card; a GitHub
       * App/OAuth `onConnect` path is CL-6343, out of scope). Resolves
       * `{ ok: false, message }` on a rejected token rather than
       * throwing, so the inline field can show the failure without a
       * modal. */
      readonly onSubmitAccessToken: (
        token: string,
      ) => Promise<
        { readonly ok: true } | { readonly ok: false; readonly message: string }
      >;
    }
  | {
      readonly kind: "connected";
      readonly orgName: string;
      readonly repos: readonly ConnectGithubRepo[];
      readonly selectedRepoIds: readonly string[];
      readonly onToggleRepo: (repoId: string) => void;
      readonly onSelectAll: () => void;
      readonly onChangeConnection: () => void;
      readonly onStartReviewing: (repoIds: readonly string[]) => void;
      readonly onSkip: () => void;
      /** Set when `onStartReviewing` rejected — the picker stays up and
       * this is the card's own alert, never a toast-only failure. */
      readonly error?: string;
    }
  | {
      readonly kind: "reviewing";
      readonly repoNames: readonly string[];
      readonly onChangeRepos: () => void;
      /** Move focus onto the reviewing scene after Start reviewing
       * succeeded, so it does not stay on a control that unmounted. */
      readonly autoFocus?: boolean;
    };

export type ConnectGithubCardProps = ConnectGithubCardBody & {
  readonly scene: OnboardingScene;
};

function repoMetaLabel(openPullRequestCount: number): string {
  return openPullRequestCount === 0
    ? CHAT_STRINGS.blockConnectGithubNoOpenPulls
    : CHAT_STRINGS.blockConnectGithubOpenPulls(openPullRequestCount);
}

type StepState = "done" | "current" | "upcoming";

function stepStateAt(index: number, currentStepIndex: number): StepState {
  if (index < currentStepIndex) return "done";
  if (index === currentStepIndex) return "current";
  return "upcoming";
}

function stepMarkLabel(state: StepState): string | undefined {
  if (state === "done") return CHAT_STRINGS.blockConnectGithubStepDone;
  if (state === "current") return CHAT_STRINGS.blockConnectGithubStepCurrent;
  return undefined;
}

/** The card's constant framing: what this room is for, the promise under
 * it, and where the person is in the walkthrough. Every label here is the
 * workbench's own onboarding copy, never this package's. */
function SceneHeader({ scene }: { readonly scene: OnboardingScene }) {
  const steps = scene.steps;
  const marked = steps !== undefined && steps.length === MARKABLE_STEP_COUNT;
  const currentWhy = marked ? steps[scene.currentStepIndex]?.why : undefined;
  return (
    <>
      {scene.promise !== undefined ? (
        <p className="chat-block-scene-promise">{scene.promise}</p>
      ) : null}
      {steps !== undefined && steps.length > 0 ? (
        <ol className="chat-block-scene-steps">
          {steps.map((step, index) => {
            const state = stepStateAt(index, scene.currentStepIndex);
            const mark = marked ? stepMarkLabel(state) : undefined;
            return (
              <li
                key={step.title}
                className="chat-block-scene-step"
                {...(marked ? { "data-state": state } : {})}
                aria-current={
                  marked && state === "current" ? "step" : undefined
                }
              >
                <span className="chat-block-scene-step-title">
                  {step.title}
                </span>
                {mark !== undefined ? (
                  <span className="chat-block-scene-step-mark">{mark}</span>
                ) : null}
              </li>
            );
          })}
        </ol>
      ) : null}
      {currentWhy !== undefined ? (
        <p className="chat-block-text chat-block-scene-why">{currentWhy}</p>
      ) : null}
    </>
  );
}

/** The walkthrough's done state: the repos under review, what happens in
 * them now, and one quiet way back to the picker. Deliberately says
 * nothing about connecting — this card is past that. */
function ReviewingBody({
  repoNames,
  onChangeRepos,
  autoFocus,
}: {
  readonly repoNames: readonly string[];
  readonly onChangeRepos: () => void;
  readonly autoFocus?: boolean;
}) {
  const sceneRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (autoFocus === true) sceneRef.current?.focus();
  }, [autoFocus]);
  return (
    <div
      className="chat-block-scene-reviewing"
      ref={sceneRef}
      {...(autoFocus === true ? { tabIndex: -1 } : {})}
    >
      <p className="chat-block-connect-line">
        <span className="chat-block-connect-tick" aria-hidden="true">
          <Check />
        </span>
        {CHAT_STRINGS.blockConnectGithubReviewingHeadline}
      </p>
      <ul className="chat-block-scene-repo-names">
        {repoNames.map((name) => (
          <li key={name}>{name}</li>
        ))}
      </ul>
      <p className="chat-block-text chat-block-connect-helper">
        {CHAT_STRINGS.blockConnectGithubReviewingLine}
      </p>
      <div className="chat-block-actions">
        <Button type="button" variant="link" onClick={onChangeRepos}>
          {CHAT_STRINGS.blockConnectGithubChangeRepos}
        </Button>
      </div>
    </div>
  );
}

function DisconnectedBody({
  onConnect,
  onSubmitAccessToken,
}: {
  readonly onConnect: () => void;
  readonly onSubmitAccessToken: (
    token: string,
  ) => Promise<
    { readonly ok: true } | { readonly ok: false; readonly message: string }
  >;
}) {
  const [fieldOpen, setFieldOpen] = useState(false);
  const [token, setToken] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  function openField() {
    onConnect();
    setFieldOpen(true);
  }

  async function submit() {
    if (token.trim() === "" || submitting) return;
    setSubmitting(true);
    setError(undefined);
    const result = await onSubmitAccessToken(token.trim());
    setSubmitting(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setToken("");
    setFieldOpen(false);
  }

  if (fieldOpen) {
    return (
      <>
        <p className="chat-block-text">
          {CHAT_STRINGS.blockConnectGithubIntro}
        </p>
        <ol className="chat-block-text chat-block-connect-steps">
          {CHAT_STRINGS.blockConnectGithubTokenSteps.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
        <p className="chat-block-text chat-block-connect-helper">
          <a
            href={CHAT_STRINGS.blockConnectGithubTokenSettingsUrl}
            target="_blank"
            rel="noreferrer"
          >
            {CHAT_STRINGS.blockConnectGithubTokenSettingsLink}
          </a>
        </p>
        <label
          className="chat-block-text chat-block-connect-token-label"
          htmlFor="connect-github-token"
        >
          {CHAT_STRINGS.blockConnectGithubTokenFieldLabel}
        </label>
        <Input
          id="connect-github-token"
          type="password"
          value={token}
          placeholder={CHAT_STRINGS.blockConnectGithubTokenFieldPlaceholder}
          onChange={(event) => {
            setToken(event.target.value);
          }}
          disabled={submitting}
          {...(error !== undefined ? { "aria-invalid": true } : {})}
        />
        {error !== undefined ? (
          <p
            className="chat-block-text chat-block-connect-token-error"
            role="alert"
          >
            {error}
          </p>
        ) : null}
        <div className="chat-block-actions">
          <Button
            type="button"
            variant="primary"
            onClick={() => void submit()}
            disabled={submitting || token.trim() === ""}
          >
            {submitting
              ? CHAT_STRINGS.blockConnectGithubTokenSubmitting
              : CHAT_STRINGS.blockConnectGithubTokenSubmit}
          </Button>
          <Button
            type="button"
            variant="link"
            onClick={() => {
              setFieldOpen(false);
              setToken("");
              setError(undefined);
            }}
          >
            {CHAT_STRINGS.blockConnectGithubTokenCancel}
          </Button>
        </div>
      </>
    );
  }

  return (
    <>
      <p className="chat-block-text">{CHAT_STRINGS.blockConnectGithubIntro}</p>
      <div className="chat-block-actions">
        <Button type="button" variant="primary" onClick={openField}>
          {CHAT_STRINGS.blockConnectGithubAction}
        </Button>
      </div>
      <p className="chat-block-text chat-block-connect-helper">
        {CHAT_STRINGS.blockConnectGithubTokenHelper}
      </p>
    </>
  );
}

function ConnectedBody({
  orgName,
  repos,
  selectedRepoIds,
  onToggleRepo,
  onSelectAll,
  onChangeConnection,
  onStartReviewing,
  onSkip,
  error,
}: Extract<ConnectGithubCardProps, { kind: "connected" }>) {
  const pickedCount = selectedRepoIds.length;
  return (
    <>
      <p className="chat-block-connect-line">
        <span className="chat-block-connect-tick" aria-hidden="true">
          <Check />
        </span>
        {CHAT_STRINGS.blockConnectGithubConnectedAs(orgName)}
        <Button type="button" variant="link" onClick={onChangeConnection}>
          {CHAT_STRINGS.blockConnectGithubChange}
        </Button>
      </p>

      <div className="chat-block-connect-count-row">
        <span>
          {CHAT_STRINGS.blockConnectGithubRepoCount(repos.length, pickedCount)}
        </span>
        <Button type="button" variant="link" onClick={onSelectAll}>
          {CHAT_STRINGS.blockConnectGithubSelectAll}
        </Button>
      </div>

      <div
        className="chat-block-connect-repo-list"
        role="group"
        aria-label={CHAT_STRINGS.blockConnectGithubPickHeadline}
      >
        {repos.map((repo) => {
          const selected = selectedRepoIds.includes(repo.id);
          const checkboxId = `connect-github-repo-${repo.id}`;
          return (
            <div key={repo.id} className="chat-block-connect-repo-row">
              <Checkbox
                id={checkboxId}
                checked={selected}
                onCheckedChange={() => onToggleRepo(repo.id)}
              />
              <label
                htmlFor={checkboxId}
                className="chat-block-connect-repo-label"
              >
                <span className="chat-block-connect-repo-name">
                  {repo.name}
                </span>
                <span className="chat-block-connect-repo-meta">
                  {repoMetaLabel(repo.openPullRequestCount)}
                </span>
              </label>
            </div>
          );
        })}
      </div>

      <p className="chat-block-text chat-block-connect-helper">
        {CHAT_STRINGS.blockConnectGithubPermissionHelper}
      </p>

      {error !== undefined ? (
        <p className="chat-block-text" role="alert">
          {error}
        </p>
      ) : null}

      <div className="chat-block-actions">
        <Button
          type="button"
          variant="primary"
          onClick={() => onStartReviewing(selectedRepoIds)}
          disabled={pickedCount === 0}
        >
          {CHAT_STRINGS.blockConnectGithubStartReviewing(pickedCount)}
        </Button>
        <Button type="button" variant="link" onClick={onSkip}>
          {CHAT_STRINGS.blockConnectGithubSkip}
        </Button>
      </div>
    </>
  );
}

export function ConnectGithubBlockView(props: ConnectGithubCardProps) {
  return (
    <BlockCard title={props.scene.title}>
      <SceneHeader scene={props.scene} />
      <div className="chat-block-scene-body" aria-live="polite">
        {props.kind === "disconnected" ? (
          <DisconnectedBody
            onConnect={props.onConnect}
            onSubmitAccessToken={props.onSubmitAccessToken}
          />
        ) : null}
        {props.kind === "connected" ? <ConnectedBody {...props} /> : null}
        {props.kind === "reviewing" ? (
          <ReviewingBody
            repoNames={props.repoNames}
            onChangeRepos={props.onChangeRepos}
            {...(props.autoFocus === true ? { autoFocus: true } : {})}
          />
        ) : null}
      </div>
    </BlockCard>
  );
}
