// Wires the presentational `ConnectServiceBlockView` to a live
// `ConnectServiceActions` port — the `ConnectGithubBlockContainer`
// shape: one `getConnectState` read on mount, then live
// `subscribeConnectState` folds, keyed by the block's `connectorId`
// rather than the message id since the state is the tenant's, not the
// room's. With no port (or while loading), the card renders the
// disconnected key-paste-free framing with a disabled-by-inaction
// connect that goes nowhere, matching the "no port, no feature"
// fallback every other block uses.
import { useEffect, useState } from "react";
import type { ConnectServiceBlockData } from "@corbits/chat/blocks";

import type {
  ConnectServiceActions,
  ConnectServiceQuery,
} from "./connect-service-actions";
import { ConnectServiceBlockView } from "./connect-service-block";

export function ConnectServiceBlockContainer({
  data,
  actions,
}: {
  readonly data: ConnectServiceBlockData;
  readonly actions?: ConnectServiceActions;
}) {
  const [query, setQuery] = useState<ConnectServiceQuery>({ kind: "loading" });

  useEffect(() => {
    if (actions === undefined) return;
    let cancelled = false;

    function applyQuery(result: ConnectServiceQuery) {
      if (cancelled) return;
      setQuery(result);
    }

    void actions.getConnectState(data.connectorId).then(applyQuery);
    const unsubscribe = actions.subscribeConnectState(
      data.connectorId,
      applyQuery,
    );
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [actions, data.connectorId]);

  if (query.kind === "connected") {
    return (
      <ConnectServiceBlockView kind="connected" displayName={data.displayName} />
    );
  }

  const affordance = query.kind === "disconnected" ? query.affordance : "oauth";
  return (
    <ConnectServiceBlockView
      kind="disconnected"
      displayName={data.displayName}
      reason={data.reason}
      affordance={affordance}
      {...(query.kind === "disconnected" && query.docsUrl !== undefined
        ? { docsUrl: query.docsUrl }
        : {})}
      onConnect={() => void actions?.connect(data.connectorId)}
      onSubmitKey={(key) =>
        actions !== undefined
          ? actions.submitKey(data.connectorId, key)
          : Promise.resolve({ ok: false, message: "Not available." })
      }
    />
  );
}
