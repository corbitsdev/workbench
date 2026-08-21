// Wires the presentational `ConnectGithubBlockView` to a live
// `ConnectGithubActions` port (CL-6345) — mirroring `PollBlockView`'s
// own container shape: an initial `getConnectState` read on mount, plus
// a live `subscribeConnectState` fold for every update after. With no
// port at all, the card renders the same fixed-disabled disconnected
// framing every other block's "no port, no feature" fallback uses.
//
// CL-6463: a card's own successful PAT submit is the one change this
// container never waits on a fold for. `subscribeConnectState` folds
// whatever a host chooses to publish, and the room's `chat.settings`
// event (the only thing `connect-github-stream.ts` can fold) is written
// by the later, unrelated repo-review PATCH — never by the credential
// save itself. So `submitAccessToken` gets its own explicit
// `getConnectState` refetch here, run once as the direct consequence of
// that one submit — not a poll, and not a second source of truth
// alongside the fold; the fold keeps handling every other update.
import { useCallback, useEffect, useRef, useState } from "react";
import type { ConnectGithubBlockData } from "@corbits/chat/blocks";

import type {
  ConnectGithubActions,
  ConnectGithubQuery,
} from "./connect-github-actions";
import { ConnectGithubBlockView } from "./connect-github-block";

export function ConnectGithubBlockContainer({
  messageId,
  actions,
}: {
  readonly data: ConnectGithubBlockData;
  readonly messageId: string;
  readonly actions?: ConnectGithubActions;
}) {
  const [query, setQuery] = useState<ConnectGithubQuery>({ kind: "loading" });
  const [selectedRepoIds, setSelectedRepoIds] = useState<readonly string[]>([]);
  const mountedRef = useRef(true);

  const applyQuery = useCallback((result: ConnectGithubQuery) => {
    if (!mountedRef.current) return;
    setQuery(result);
    if (result.kind === "connected") setSelectedRepoIds(result.selectedRepoIds);
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (actions === undefined) return;
    actions.getConnectState(messageId).then(applyQuery);
    const unsubscribe = actions.subscribeConnectState(messageId, applyQuery);
    return unsubscribe;
  }, [actions, messageId, applyQuery]);

  // The one refetch this container ever runs outside its mount effect:
  // a submit this card itself just made succeeded, so re-reading the
  // card's own state is a direct consequence of that submit — never a
  // poll, and it runs whether or not the host's `subscribeConnectState`
  // happens to fan the change out on its own.
  const submitAccessTokenAndRefresh = useCallback(
    async (token: string) => {
      if (actions === undefined) {
        return { ok: false as const, message: "Not available." };
      }
      const result = await actions.submitAccessToken(token);
      if (result.ok) {
        applyQuery(await actions.getConnectState(messageId));
      }
      return result;
    },
    [actions, messageId, applyQuery],
  );

  if (actions === undefined || query.kind !== "connected") {
    return (
      <ConnectGithubBlockView
        kind="disconnected"
        onConnect={() => actions?.requestConnect()}
        onSubmitAccessToken={submitAccessTokenAndRefresh}
      />
    );
  }

  function toggleRepo(repoId: string) {
    setSelectedRepoIds((current) =>
      current.includes(repoId)
        ? current.filter((id) => id !== repoId)
        : [...current, repoId],
    );
  }

  return (
    <ConnectGithubBlockView
      kind="connected"
      orgName={query.orgName}
      repos={query.repos}
      selectedRepoIds={selectedRepoIds}
      onToggleRepo={toggleRepo}
      onSelectAll={() => setSelectedRepoIds(query.repos.map((repo) => repo.id))}
      onChangeConnection={actions.requestConnect}
      onStartReviewing={(repoIds) => {
        void actions.startReviewing(repoIds);
      }}
      onSkip={() => {
        void actions.skip();
      }}
    />
  );
}
