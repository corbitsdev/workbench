import { useEffect, useRef } from "react";

import { claimAutoRedeploy } from "@/chat/redeploy-failures";
import { useRestartAgent } from "./use-restart-agent";

// Renders nothing; a mount's own ref plus the mutation's `isPending`/
// `isSuccess` keep StrictMode's double effect from firing it twice. Fires
// from an effect, never during render: mutating mid-render updates the
// mutation's own state on a fiber that hasn't mounted yet (React warns).
// The claim keeps the chat page and the workers list from both redeploying
// the same agent.
export function AgentRedeployer({
  workbenchTenantId,
  agent,
}: {
  readonly workbenchTenantId: string;
  readonly agent: {
    readonly id: string;
    readonly name: string;
    readonly assetName: string;
  };
}) {
  const started = useRef(false);
  const redeploy = useRestartAgent();
  useEffect(() => {
    if (started.current || redeploy.isPending || redeploy.isSuccess) return;
    started.current = true;
    if (claimAutoRedeploy(agent.id)) redeploy.mutate({ tenantId: workbenchTenantId, agent });
  });
  return null;
}
