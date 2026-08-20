// The GitHub connect card renders both states of the first-run connect flow
// (CL-6342 screen 2) inline in the room, using the same `BlockCard` frame
// every other block uses -- there is no settings page or dialog for this.
// Selection is controlled: like `PollBlockView` never keeps its own tally,
// this view never owns which repos are picked -- it renders what it's given
// and reports toggles upward. Wiring these callbacks to the real GitHub
// connection API is the next slice; this one is pure and props-driven so it
// can be exercised and reviewed without a server.
//
// The repo row's control is `@corbits/react-ui`'s own `Checkbox` (bare
// mode) rather than a hand-rolled input -- AGENTS.md puts generic controls
// upstream in react-ui, not here. Its corner radius is react-ui's rounded
// default, a visual delta from the mock's flat radius-0 system; the row
// layout around it (name left, open-PR count right) is workbench-specific
// composition and stays local.

import { Button, Checkbox } from "@corbits/react-ui";

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
      readonly onUseAccessToken: () => void;
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
  onUseAccessToken,
}: {
  readonly onConnect: () => void;
  readonly onUseAccessToken: () => void;
}) {
  return (
    <>
      <p className="chat-block-text">{CHAT_STRINGS.blockConnectGithubIntro}</p>
      <div className="chat-block-actions">
        <Button type="button" variant="primary" onClick={onConnect}>
          {CHAT_STRINGS.blockConnectGithubAction}
        </Button>
      </div>
      <p className="chat-block-text chat-block-connect-helper">
        {CHAT_STRINGS.blockConnectGithubTokenPrompt}{" "}
        <Button type="button" variant="link" onClick={onUseAccessToken}>
          {CHAT_STRINGS.blockConnectGithubTokenLink}
        </Button>
        {CHAT_STRINGS.blockConnectGithubTokenTrust}
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
          ✓
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
          onUseAccessToken={props.onUseAccessToken}
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
