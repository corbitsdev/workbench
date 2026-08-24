// Whether this deployment has certain optional integrations configured —
// today, only whether Slack tag ingress is mounted (see
// apps/hub/src/index.ts's `/api/deployment-capabilities`, computed from the
// same `SLACK_BOT_TOKEN`/`SLACK_SIGNING_SECRET` env gate
// `slack-tag-mount.ts` checks). No session or tenant is required: the
// routine trigger popover (see `shell/routine-panel.tsx`) reads this to
// decide whether a Slack-bound webhook trigger is honestly offerable, the
// same way `/api/auth-config` decides which sign-in buttons to draw.
//
// Distinguishes "the hub answered and Slack is not configured" (`ready`
// with `slackConfigured: false`) from a network failure, non-2xx, or
// unparseable body (`unavailable`). Collapsing those into
// `{ slackConfigured: false }` was CL-6835 — the trigger affordance
// disappeared with no error whenever the probe missed.
import { type } from "arktype";
import { useQuery } from "@tanstack/react-query";

const DeploymentCapabilitiesBody = type({
  slackConfigured: "boolean",
});
export type DeploymentCapabilities = typeof DeploymentCapabilitiesBody.infer;

export type DeploymentCapabilitiesResult =
  | { readonly kind: "ready"; readonly slackConfigured: boolean }
  | { readonly kind: "unavailable"; readonly message: string };

export async function fetchDeploymentCapabilities(): Promise<DeploymentCapabilitiesResult> {
  try {
    const response = await fetch("/api/deployment-capabilities", {
      headers: { accept: "application/json" },
    });
    if (!response.ok) {
      return {
        kind: "unavailable",
        message: `The server answered ${response.status} when checking Slack.`,
      };
    }
    const body: unknown = await response.json();
    const parsed = DeploymentCapabilitiesBody(body);
    if (parsed instanceof type.errors) {
      return {
        kind: "unavailable",
        message: `Unexpected Slack capabilities shape: ${parsed.summary}`,
      };
    }
    return { kind: "ready", slackConfigured: parsed.slackConfigured };
  } catch (cause) {
    return {
      kind: "unavailable",
      message: cause instanceof Error ? cause.message : String(cause),
    };
  }
}

/**
 * Whether the routine trigger popover should offer Slack. Still-loading
 * hides it (don't claim configured); a ready answer follows the hub; a
 * probe failure keeps it offered — disappearing solely because the probe
 * failed is the CL-6835 bug.
 */
export function slackTriggerOffered(
  result: DeploymentCapabilitiesResult | null,
): boolean {
  if (result === null) return false;
  if (result.kind === "unavailable") return true;
  return result.slackConfigured;
}

/** `null` while the probe is in flight — consumers must not treat that as
 * "Slack is not configured". */
export function useDeploymentCapabilities(): DeploymentCapabilitiesResult | null {
  const { data } = useQuery({
    queryKey: ["deployment-capabilities"],
    queryFn: fetchDeploymentCapabilities,
    staleTime: Infinity,
  });
  return data ?? null;
}
