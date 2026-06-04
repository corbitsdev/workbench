import { createDefaultDirector } from '@intx/inference';
import type {
  ReactorDirector,
  ReactorInboundEvent,
  ReactorState,
  ReactorCapabilities,
  ReactorAction,
  ToolDefinition,
} from '@intx/types/runtime';

/**
 * Create a custom director for the personal agent.
 *
 * The personal agent is a chief-of-staff orchestrator. Its director filters
 * unsolicited inbound messages — if a message arrives from a sender not in
 * `allowedSenders`, the agent replies with "Not authorised" and waits for the
 * next event rather than passing the message to inference.
 *
 * All other events (inference.done, tool.done, etc.) are delegated to the
 * default director so the agentic loop works normally.
 *
 * @param systemPrompt     The agent's system prompt string.
 * @param toolDefinitions  Tool definitions the agent has access to.
 * @param allowedSenders   Email addresses the agent accepts unsolicited mail from.
 *                         Pass an empty array to accept mail from any sender.
 */
export function createPersonalAgentDirector(
  systemPrompt: string,
  toolDefinitions: ToolDefinition[],
  allowedSenders: string[]
): ReactorDirector {
  const base = createDefaultDirector(systemPrompt, toolDefinitions);

  return {
    async decide(
      event: ReactorInboundEvent,
      state: ReactorState,
      capabilities: ReactorCapabilities
    ): Promise<ReactorAction | ReactorAction[]> {
      if (event.type === 'message.received' && allowedSenders.length > 0) {
        const sender = event.message.headers.from;
        if (!allowedSenders.includes(sender)) {
          return [capabilities.reply('Not authorised'), capabilities.wait()];
        }
      }
      return base.decide(event, state, capabilities);
    },
  };
}
