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
 * Create a custom director for the Granola agent.
 *
 * The Granola agent only accepts inbound messages from an explicitly listed
 * set of allowed senders. Any other sender receives "Not authorised" and the
 * agent returns to waiting.
 *
 * All other events delegate to the default director.
 *
 * @param systemPrompt      Granola agent's system prompt.
 * @param toolDefinitions   Tool definitions the agent has access to.
 * @param allowedSenders    Addresses the agent accepts mail from. The hub's
 *                          per-instance scheduler sends from
 *                          'scheduler@system'; include it here if needed.
 */
export function createGranolaDirector(
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
      if (event.type === 'message.received') {
        const sender = event.message.headers.from;
        if (!allowedSenders.includes(sender)) {
          return [capabilities.reply('Not authorised'), capabilities.wait()];
        }
      }
      return base.decide(event, state, capabilities);
    },
  };
}
