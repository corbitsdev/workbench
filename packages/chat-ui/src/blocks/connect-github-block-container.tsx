// Wires the presentational `ConnectGithubBlockView` to a live
// `ConnectGithubActions` port (CL-6345) — mirroring `PollBlockView`'s
// own container shape: an initial `getConnectState` read on mount, plus
// a live `subscribeConnectState` fold for every update after, never a
// second fetch once mounted. With no port at all, the card renders the
// same fixed-disabled disconnected framing every other block's "no
// port, no feature" fallback uses.
import { useEffect, useState } from "react";
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

  useEffect(() => {
    if (actions === undefined) return;
    let cancelled = false;

    function applyQuery(result: ConnectGithubQuery) {
      if (cancelled) return;
      setQuery(result);
      if (result.kind === "connected")
        setSelectedRepoIds(result.selectedRepoIds);
    }

    actions.getConnectState(messageId).then(applyQuery);
    const unsubscribe = actions.subscribeConnectState(messageId, applyQuery);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [actions, messageId]);

  if (actions === undefined || query.kind !== "connected") {
    return (
      <ConnectGithubBlockView
        kind="disconnected"
        onConnect={() => actions?.requestConnect()}
        onSubmitAccessToken={(token) =>
          actions !== undefined
            ? actions.submitAccessToken(token)
            : Promise.resolve({ ok: false, message: "Not available." })
        }
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
