// Keyed by `connectorId`, not the message id, since the state is the
// tenant's, not the workbench's. No port: "no port, no feature" fallback.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import type { ConnectServiceBlockData } from "../wire/blocks";

import type { ConnectServiceActions, ConnectServiceQuery } from "./connect-service-actions";
import { ConnectServiceBlockView } from "./connect-service-block";

export function ConnectServiceBlockContainer({
  data,
  actions,
}: {
  readonly data: ConnectServiceBlockData;
  readonly actions?: ConnectServiceActions;
}) {
  const queryClient = useQueryClient();
  // Keyed by connector, not by message: the connection is the tenant's, so
  // every card for the same service shares one read.
  const queryKey = ["connect-state", data.connectorId] as const;
  const live = useQuery<ConnectServiceQuery>({
    queryKey,
    queryFn: () =>
      actions === undefined
        ? Promise.resolve<ConnectServiceQuery>({ kind: "loading" })
        : actions.getConnectState(data.connectorId),
    enabled: actions !== undefined,
  });
  const query: ConnectServiceQuery = live.data ?? { kind: "loading" };

  // The live fold is a subscription, so it writes into the cache the read
  // above already owns rather than keeping a second copy beside it.
  useEffect(() => {
    if (actions === undefined) return;
    return actions.subscribeConnectState(data.connectorId, (result) => {
      queryClient.setQueryData(queryKey, result);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- queryKey is derived from connectorId
  }, [actions, data.connectorId, queryClient]);

  if (query.kind === "connected") {
    return <ConnectServiceBlockView kind="connected" displayName={data.displayName} />;
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
