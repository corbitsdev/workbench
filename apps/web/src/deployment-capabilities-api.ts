// Whether this deployment has certain optional integrations configured —
// today, only whether Slack tag ingress is mounted (see
// apps/hub/src/index.ts's `/api/deployment-capabilities`, computed from the
// same `SLACK_BOT_TOKEN`/`SLACK_SIGNING_SECRET` env gate
// `slack-tag-mount.ts` checks). No session or tenant is required: the
// routine trigger popover (see `shell/routine-panel.tsx`) reads this to
// decide whether a Slack-bound webhook trigger is honestly offerable, the
// same way `/api/auth-config` decides which sign-in buttons to draw.
import { type } from "arktype";
import { useQuery } from "@tanstack/react-query";

const DeploymentCapabilities = type({
  slackConfigured: "boolean",
});
export type DeploymentCapabilities = typeof DeploymentCapabilities.infer;

const UNAVAILABLE: DeploymentCapabilities = { slackConfigured: false };

export async function fetchDeploymentCapabilities(): Promise<DeploymentCapabilities> {
  const response = await fetch("/api/deployment-capabilities", {
    headers: { accept: "application/json" },
  }).catch(() => null);
  if (response === null || !response.ok) return UNAVAILABLE;
  const body: unknown = await response.json().catch(() => undefined);
  const parsed = DeploymentCapabilities(body);
  return parsed instanceof type.errors ? UNAVAILABLE : parsed;
}

/** Absent (still fetching), never claims Slack is configured — the trigger
 * popover's own "hide when not available" default. */
export function useDeploymentCapabilities(): DeploymentCapabilities {
  const { data } = useQuery({
    queryKey: ["deployment-capabilities"],
    queryFn: fetchDeploymentCapabilities,
    staleTime: Infinity,
  });
  return data ?? UNAVAILABLE;
}
