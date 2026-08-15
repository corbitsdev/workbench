// Instant agent creation — the "+ New chat" picker's "Create new agent" row
// skips `create-agent-panel.tsx`'s form entirely: draft a starting system
// prompt for a default name, create the definition, then land in its chat
// the same way picking an existing agent does (`launchAgentChat`).
// `CreateAgentPanel`'s own form stays the path for Settings → Agents and
// anyone who wants to steer name/purpose/model/skills up front.

import { ApiQueryError } from "@corbits/api-query";

import { launchAgentChat } from "./agent-chat-launch";
import { createAgentDefinition, draftAgentDefinition } from "./agents-api";
import type { AgentDefinition } from "./agents-api";

export const DEFAULT_AGENT_NAME = "New agent";
const MAX_HANDLE_ATTEMPTS = 20;

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function isHandleConflict(cause: unknown): boolean {
  return cause instanceof ApiQueryError && cause.status === 409;
}

/**
 * Numbers the handle on a repeat ("new-agent", then "new-agent-2",
 * "new-agent-3", …) — the server has no dedup of its own for a duplicate
 * handle (`packages/agent-directory`'s uniqueness check 409s on a repeat),
 * and every "Create new agent" click reuses the same default name.
 */
export function handleAttempt(baseHandle: string, attempt: number): string {
  return attempt === 0 ? baseHandle : `${baseHandle}-${attempt + 1}`;
}

/**
 * Drafts and creates an agent with `name` (defaulting to "New agent"), then
 * navigates into its chat — the exact create-and-launch path
 * `CreateAgentPanel.onCreated` also drives, minus the form in front of it.
 */
export async function createAgentAndLaunch(
  tenantId: string,
  navigate: (to: string) => void,
  name: string = DEFAULT_AGENT_NAME,
): Promise<AgentDefinition> {
  const draft = await draftAgentDefinition(tenantId, { name });
  const baseHandle = slugify(name);
  for (let attempt = 0; attempt < MAX_HANDLE_ATTEMPTS; attempt += 1) {
    try {
      const created = await createAgentDefinition(tenantId, {
        name,
        handle: handleAttempt(baseHandle, attempt),
        systemPrompt: draft.systemPrompt,
        ...(draft.description !== undefined
          ? { description: draft.description }
          : {}),
        ...(draft.modelPreference !== undefined
          ? { model: draft.modelPreference }
          : {}),
        ...(draft.skills !== undefined && draft.skills.length > 0
          ? { skills: draft.skills }
          : {}),
      });
      await launchAgentChat(tenantId, created.id, navigate);
      return created;
    } catch (cause) {
      if (!isHandleConflict(cause)) throw cause;
    }
  }
  throw new Error(`Could not find a free handle for "${name}".`);
}
