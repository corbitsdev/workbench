import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toHumanLabel } from "@workbench/ui";
import {
  listAutoApprovedTools,
  revokeAutoApprovedTool,
  type AutoApprovedTool,
} from "../lib/approvals-api";
import { providerLabel } from "../lib/tool-providers";

/** A friendly label for a durably auto-approved LLM-safe tool name, e.g.
 * `slack__post_message` → "Post Message (Slack)", `mail_send` → "Mail Send". */
function toolLabel(name: string): string {
  const [provider, ...rest] = name.split("__");
  if (rest.length > 0 && provider !== undefined) {
    return `${toHumanLabel(rest.join("__"))} (${providerLabel(provider)})`;
  }
  return toHumanLabel(name);
}

/**
 * The member-facing list of durable "Auto Approve Always" decisions, each with a
 * revoke that reverts the tool to requiring approval on the next grant
 * reconcile. This is the undo surface for the durable trust grant (CL-3942) — no
 * standing auto-approval is left without a way to remove it.
 */
export function AutoApprovedToolsPanel({ tenantId }: { tenantId: string }) {
  const queryClient = useQueryClient();
  const enabled = tenantId !== "";

  const { data: tools = [], isLoading } = useQuery({
    queryKey: ["auto-approved-tools", tenantId],
    enabled,
    queryFn: () => listAutoApprovedTools(tenantId),
  });

  const revoke = useMutation({
    mutationFn: (id: string) => revokeAutoApprovedTool(tenantId, id),
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: ["auto-approved-tools", tenantId],
      }),
  });

  if (isLoading) {
    return <p className="text-sm text-text-2">Loading…</p>;
  }

  if (tools.length === 0) {
    return (
      <p className="text-sm text-text-2">
        You have no always-approved actions. When you choose “Auto Approve
        Always” on an approval, the action appears here so you can undo it.
      </p>
    );
  }

  return (
    <ul className="flex flex-col gap-2" data-testid="auto-approved-tools-list">
      {tools.map((tool: AutoApprovedTool) => (
        <li
          key={tool.id}
          className="flex items-center justify-between gap-3 rounded-lg border border-border bg-surface px-4 py-3"
        >
          <span className="text-sm font-medium text-text">
            {toolLabel(tool.toolName)}
          </span>
          <button
            type="button"
            disabled={revoke.isPending}
            onClick={() => {
              revoke.mutate(tool.id);
            }}
            className="rounded-input bg-surface-2 px-3 py-1.5 text-[12.5px] font-semibold text-text-2 transition-colors hover:bg-surface hover:text-text disabled:opacity-50"
            data-testid={`revoke-auto-approved-${tool.id}`}
          >
            {revoke.isPending ? "Removing…" : "Revoke"}
          </button>
        </li>
      ))}
    </ul>
  );
}
