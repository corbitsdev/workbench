// CL-7108: the agent-DM pin — the ONE place that says what an agent DM
// is. An agent DM is a `kind: "chat"` conversation carrying a
// `chat/definitionId`: the one 1:1 (tenant, agent) conversation. The
// client mints it through stock Interchange and stamps the definition
// id in the settings it writes; the server never mints DMs — this
// module only validates what the client wrote (see
// `definitionIdOfSettings` / `isAgentDmSettings` below).
//
// Why DMs differ from rooms is chat-layer only — the execution plane is
// identical. A DM's agent runs the same interactive warm-mailbox shape a
// room agent does: one standing per-agent run, provisioned once (at first
// message, ahead of the member's first turn) from the conversation's
// single-definition asset, every inbound mail a header-threaded turn on
// that run, the turn rows a durable per-run INBOX verifiable in the hub
// replica, and the agent's `mail_wait` wired in the one place the
// execution plane parks (the run child's watch registry — the chat layer
// never parks awaiting agent mail; dispatch is fire-and-forget and the
// agent-turns projection plus the turn-mail correlation carry the trail).
// What makes a DM a DM lives entirely here at the chat layer: the 1:1
// identity this pin names, the sidebar bucket, the greeting —
// validated, never minted.
//
// Every settings-level reader and writer of DM-ness goes through this
// module's keys and predicate — never a second inline `chat/definitionId`
// literal beside it — so the pin cannot drift between mint, reopen, the
// workbench view, and the launch gate.
export const AGENT_DM_KIND = "chat";

export const AGENT_DM_DEFINITION_ID_KEY = "chat/definitionId";

/** The agent this DM was minted for, or `undefined` when the settings
 * carry no (string) definition id. Non-string values are not a DM's agent
 * — validation at the trust boundary, not a fallback path. */
export function definitionIdOfSettings(
  settings: Record<string, unknown>,
): string | undefined {
  const value = settings[AGENT_DM_DEFINITION_ID_KEY];
  return typeof value === "string" ? value : undefined;
}

/** Whether these settings are an agent DM: kind `chat` (a missing kind
 * reads as `chat`, mirroring `kindOf` in `./workbench-settings.ts`) with
 * a definition id naming its agent. */
export function isAgentDmSettings(settings: Record<string, unknown>): boolean {
  const kind = settings["chat/kind"];
  const effectiveKind = typeof kind === "string" ? kind : AGENT_DM_KIND;
  return (
    effectiveKind === AGENT_DM_KIND &&
    definitionIdOfSettings(settings) !== undefined
  );
}
