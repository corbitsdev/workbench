import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  buildApprovalDisplayLookups,
  type ApprovalDisplayLookups,
} from "../lib/approval-display";
import { listAgentInstances } from "../lib/hub-api";
import { useMembers } from "./use-members";

const EMPTY_LOOKUPS: ApprovalDisplayLookups = {
  principalById: new Map(),
  principalByRefId: new Map(),
  agentByInstanceId: new Map(),
  agentByAddress: new Map(),
};

export function useApprovalDisplayLookups(tenantId: string) {
  const membersQuery = useMembers(tenantId);
  const instancesQuery = useQuery({
    queryKey: ["approval-display-instances", tenantId],
    queryFn: () => listAgentInstances(tenantId),
    enabled: tenantId !== "",
    staleTime: 5 * 60_000,
  });

  const lookups = useMemo(() => {
    if (membersQuery.data === undefined && instancesQuery.data === undefined) {
      return EMPTY_LOOKUPS;
    }
    return buildApprovalDisplayLookups(
      membersQuery.data ?? [],
      instancesQuery.data ?? [],
    );
  }, [membersQuery.data, instancesQuery.data]);

  return {
    lookups,
    isLoading: membersQuery.isLoading || instancesQuery.isLoading,
  };
}
