// The connect-github card's one seam to the platform connection it needs
// (CL-6345) — mirroring `ApprovalActions`/`BlockResponseActions`:
// `@corbits/chat-ui` owns no session, no credential, and no query cache,
// so it never resolves a GitHub connection or lists repos itself. The
// host supplies this port, and is expected to bind it against
// `@workbench/connections`' generic `/:connectorId/complete` route
// (`github`'s PAT test-and-store — already fully generic, no bespoke
// GitHub route needed), `@corbits/github-tools`' `listRepos`, and
// `@corbits/workflow-catalog`'s `startReviewingRepos`.
import type { ConnectGithubRepo } from "./connect-github-block";
export type { ConnectGithubRepo };

export type ConnectGithubQuery =
  | { readonly kind: "loading" }
  | { readonly kind: "disconnected" }
  | {
      readonly kind: "connected";
      readonly orgName: string;
      readonly repos: readonly ConnectGithubRepo[];
      /** Repos already recorded as selected — the room's own
       * `template/selectedRepos` setting, never a client guess. */
      readonly selectedRepoIds: readonly string[];
    }
  | { readonly kind: "error"; readonly message: string };

export type ConnectGithubActions = {
  /** The live read behind the card, resolved against the real
   * connection and the room's own settings — never derived from the
   * message's own `ConnectGithubBlockData`. */
  readonly getConnectState: (messageId: string) => Promise<ConnectGithubQuery>;
  /**
   * Folds this room's live stream straight into the card's state —
   * never a second `getConnectState` call. The host wires this to the
   * workbench's existing `chat.settings` SSE event (folded through
   * `./connect-github-stream.ts`'s `applyConnectGithubSettingsEvent`),
   * the same event `templateReposSettingsPatch` writes onto once a
   * person starts reviewing repos. Returns an unsubscribe.
   */
  readonly subscribeConnectState: (
    messageId: string,
    onUpdate: (state: ConnectGithubQuery) => void,
  ) => () => void;
  /**
   * Both the card's "Connect GitHub" and "Use an access token instead"
   * actions funnel here — this repo's connect cards are PAT-first
   * today (CL-6345); a GitHub App/OAuth `onConnect` path is CL-6343,
   * explicitly out of scope. The host opens whatever PAT-entry surface
   * it already presents for other connectors; this call itself returns
   * nothing, and a successful connect is expected to arrive back
   * through the same `subscribeConnectState` channel this card already
   * holds open — never a return value the card would have to poll.
   */
  readonly requestConnect: () => void;
  /** Mints a grant and a live webhook trigger per repo id, then
   * records the selection — `@corbits/workflow-catalog`'s
   * `startReviewingRepos`, called through the host's own binding. */
  readonly startReviewing: (
    repoIds: readonly string[],
  ) => Promise<{ readonly startedTriggerCount: number }>;
  readonly skip: () => Promise<void>;
};
