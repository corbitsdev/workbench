// The GitHub connect card renders both states of the first-run connect flow
// (CL-6342 screen 2) inline in the room, using the same `BlockCard` frame
// every other block uses -- there is no settings page or dialog for this.
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

import { useState } from "react";
import { Button, Checkbox, Input } from "@corbits/react-ui";
import { Check } from "@corbits/icons";

import { CHAT_STRINGS } from "../strings";
import { BlockCard } from "./block-card";

export type ConnectGithubRepo = {
  readonly id: string;
  readonly name: string;
  readonly openPullRequestCount: number;
};

export type ConnectGithubCardProps =
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
    };

function repoMetaLabel(openPullRequestCount: number): string {
  return openPullRequestCount === 0
    ? CHAT_STRINGS.blockConnectGithubNoOpenPulls
    : CHAT_STRINGS.blockConnectGithubOpenPulls(openPullRequestCount);
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
        />
        {error !== undefined ? (
          <p className="chat-block-text chat-block-connect-token-error">
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

      <div className="chat-block-actions">
        <Button
          type="button"
          variant="primary"
          onClick={() => onStartReviewing(selectedRepoIds)}
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
  if (props.kind === "disconnected") {
    return (
      <BlockCard title={CHAT_STRINGS.blockConnectGithubHeadline}>
        <DisconnectedBody
          onConnect={props.onConnect}
          onSubmitAccessToken={props.onSubmitAccessToken}
        />
      </BlockCard>
    );
  }
  return (
    <BlockCard title={CHAT_STRINGS.blockConnectGithubPickHeadline}>
      <ConnectedBody {...props} />
    </BlockCard>
  );
}
