// Request-shaped views of this catalog's two standalone chat-agent
// participants (Scout, Jimmy), in the shape `./instantiate.ts`'s
// `createParticipantAgent` port takes — the same shape
// `@corbits/code-review/agent-requests`' `codeReviewAgentRequests`
// establishes for the reviewer roster, extended with `toolPackagePins`
// since neither Scout nor Jimmy is a pure-text agent. Built here, from
// each package's own exported definition, rather than inside
// `packages/scout-agent`/`packages/jimmy-agent` themselves: this
// package already owns "what a template participant needs to become an
// agent-directory create request" (it owns `codeReviewAgentRequests`'
// caller), so the mapping belongs beside it, not duplicated into every
// agent package that wants to be installable this way.
import { SCOUT_AGENT_DEFINITION } from "@corbits/scout-agent/definition";
import {
  JIMMY_AGENT_ID,
  JIMMY_DESCRIPTION,
  JIMMY_DISPLAY_NAME,
  JIMMY_SYSTEM_PROMPT,
  JIMMY_TOOL_PACKAGE_PINS,
} from "@corbits/jimmy-agent/metadata";

import type { ParticipantAgentRequest } from "./instantiate";

export function scoutAgentRequest(): ParticipantAgentRequest {
  return {
    name: SCOUT_AGENT_DEFINITION.displayName,
    handle: SCOUT_AGENT_DEFINITION.handle,
    description: SCOUT_AGENT_DEFINITION.description,
    systemPrompt: SCOUT_AGENT_DEFINITION.systemPrompt,
    toolPackagePins: SCOUT_AGENT_DEFINITION.toolPackagePins.map(
      (pin) => pin.name,
    ),
  };
}

/** Jimmy's own package exports an `@intx/agent`-native `AgentDefinition`
 * builder (`buildJimmyAgent`), not the `{handle, displayName, ...}`
 * plain-data shape the agent-directory create path takes — it has no
 * handle or display name of its own at all. `JIMMY_AGENT_ID` ("jimmy")
 * is both his id and the handle a person types to reach him. */
export function jimmyAgentRequest(): ParticipantAgentRequest {
  return {
    name: JIMMY_DISPLAY_NAME,
    handle: JIMMY_AGENT_ID,
    description: JIMMY_DESCRIPTION,
    systemPrompt: JIMMY_SYSTEM_PROMPT,
    toolPackagePins: JIMMY_TOOL_PACKAGE_PINS.map((pin) => pin.name),
  };
}
