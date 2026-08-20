// Folds a room's existing `chat.settings` stream event straight into a
// connect-github card's live state (CL-6345) — no new event type, no
// refetch. `@corbits/workflow-catalog`'s `templateReposSettingsPatch`
// writes `template/pendingConnections` (with `"github"` removed) and
// `template/selectedRepos` in one PATCH once a person starts reviewing
// repos; that PATCH's own route already publishes `chat.settings` with
// the full post-change settings object (`packages/chat/src/routes.ts`).
// A host wires this function as the fold behind `ConnectGithubActions`'
// `subscribeConnectState`.
import type { ChatSettingsEventData } from "@corbits/chat/stream-events";

import type {
  ConnectGithubQuery,
  ConnectGithubRepo,
} from "./connect-github-actions";

/**
 * Reads `event.settings` for this connector's own settled state.
 * Returns `undefined` when the event carries no `template/*` keys at
 * all — a settings change unrelated to this card, which a subscriber
 * should ignore rather than fold into a stale-looking update.
 */
export function applyConnectGithubSettingsEvent(
  event: ChatSettingsEventData,
  connectorId: string,
  orgName: string,
  repos: readonly ConnectGithubRepo[],
): ConnectGithubQuery | undefined {
  const pending = event.settings["template/pendingConnections"];
  if (!Array.isArray(pending)) return undefined;
  if (pending.includes(connectorId)) {
    return { kind: "disconnected" };
  }
  const selected = event.settings["template/selectedRepos"];
  return {
    kind: "connected",
    orgName,
    repos,
    selectedRepoIds: Array.isArray(selected) ? selected.map(String) : [],
  };
}
