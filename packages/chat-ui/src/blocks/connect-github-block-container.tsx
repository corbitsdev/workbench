// Wires the presentational `ConnectGithubBlockView` to a live
// `ConnectGithubActions` port (CL-6345) — mirroring `PollBlockView`'s
// own container shape: an initial `getConnectState` read on mount, plus
// a live `subscribeConnectState` fold for every update after. With no
// port at all, the card renders the same fixed-disabled disconnected
// framing every other block's "no port, no feature" fallback uses.
//
// CL-6463: a card's own successful PAT submit is the one change this
// container never waits on the host to fan out on its own — a credential
// saved through *this* card's field gets its own explicit `getConnectState`
// refetch below, run once as the direct consequence of that one submit
// (not a poll). A credential saved anywhere else (the Plugins page,
// another tab) settles through `packages/chat/src/connect-pending.ts`'s
// `settleConnectedService`, which clears this room's own
// `template/pendingConnections` entry — so this card's next mount already
// reads connected without needing a push while it sits open.
//
// CL-6741: once a card has read connected, a later loading/error fold
// (or a remount that starts on loading) must keep the last connected
// snapshot — never flash DisconnectedBody / "Connect" again over a
// known-good connection. An explicit `disconnected` result clears the
// snapshot so a real disconnect still shows Connect.
import { useCallback, useEffect, useRef, useState } from "react";
import type { ConnectGithubBlockData } from "@corbits/chat/blocks";

import type {
  ConnectGithubActions,
  ConnectGithubQuery,
} from "./connect-github-actions";
import { ConnectGithubBlockView } from "./connect-github-block";

type ConnectedGithubQuery = Extract<ConnectGithubQuery, { kind: "connected" }>;

/** Survives container remounts so a post-connect loading flash never
 * resets the card to Connect (CL-6741). Cleared only on an explicit
 * disconnected result. */
const lastConnectedByMessageId = new Map<string, ConnectedGithubQuery>();

function rememberConnected(messageId: string, query: ConnectedGithubQuery) {
  lastConnectedByMessageId.set(messageId, query);
}

function forgetConnected(messageId: string) {
  lastConnectedByMessageId.delete(messageId);
}

function lastConnectedOf(messageId: string): ConnectedGithubQuery | undefined {
  return lastConnectedByMessageId.get(messageId);
}

function displayQueryOf(
  messageId: string,
  query: ConnectGithubQuery,
): ConnectGithubQuery {
  if (query.kind === "connected" || query.kind === "disconnected") {
    return query;
  }
  const prior = lastConnectedOf(messageId);
  return prior ?? query;
}

export function ConnectGithubBlockContainer({
  messageId,
  actions,
}: {
  readonly data: ConnectGithubBlockData;
  readonly messageId: string;
  readonly actions?: ConnectGithubActions;
}) {
  const [query, setQuery] = useState<ConnectGithubQuery>(() => {
    return lastConnectedOf(messageId) ?? { kind: "loading" };
  });
  const [selectedRepoIds, setSelectedRepoIds] = useState<readonly string[]>(
    () => lastConnectedOf(messageId)?.selectedRepoIds ?? [],
  );
  const mountedRef = useRef(true);

  const applyQuery = useCallback(
    (result: ConnectGithubQuery) => {
      if (!mountedRef.current) return;
      if (result.kind === "connected") {
        rememberConnected(messageId, result);
        setSelectedRepoIds(result.selectedRepoIds);
      } else if (result.kind === "disconnected") {
        forgetConnected(messageId);
      }
      setQuery(result);
    },
    [messageId],
  );

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

  const displayQuery = displayQueryOf(messageId, query);

  if (actions === undefined || displayQuery.kind !== "connected") {
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
      orgName={displayQuery.orgName}
      repos={displayQuery.repos}
      selectedRepoIds={selectedRepoIds}
      onToggleRepo={toggleRepo}
      onSelectAll={() =>
        setSelectedRepoIds(displayQuery.repos.map((repo) => repo.id))
      }
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
