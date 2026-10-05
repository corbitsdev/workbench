import { toast } from "@corbits/react-ui/ui/toast";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { workbenchKeys } from "./chat-path";
import { tenantKeys } from "./query-client";
import { redeployWorkbenchAgent, reportRestartFailure } from "./workbench-create";

/** The one way an agent is put back to work: a person's Restart and the
 * automatic redeploy of a dead worker both go through it. */
export function useRestartAgent() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      tenantId,
      agent,
    }: {
      readonly tenantId: string;
      readonly agent: { readonly id: string; readonly name: string; readonly assetName: string };
    }) => redeployWorkbenchAgent(tenantId, agent),
    onSettled: (_result, _error, { tenantId }) =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: workbenchKeys.scope(tenantId) }),
        queryClient.invalidateQueries({ queryKey: tenantKeys.agents(tenantId) }),
      ]),
    onError: (cause, { tenantId }) => toast(reportRestartFailure(cause, tenantId)),
  });
}
