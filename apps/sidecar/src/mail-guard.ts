import { getLogger } from '@intx/log';
import type { ToolCall, ToolResult, ToolDefinition, ToolRunner } from '@intx/types/runtime';

const logger = getLogger(['sidecar', 'mail-guard']);

/** Mail tools that emit outbound messages and so can run away in a loop. */
const MAIL_WRITE_TOOLS = new Set(['mail_send', 'mail_reply']);

/**
 * How many times the same exact body may be sent. The first send goes through;
 * any further identical body is suppressed — the ~15 repeated browser-error
 * replies we saw in production were all byte-identical.
 */
export const MAX_IDENTICAL_OUTBOUND = 1;

/**
 * Hard ceiling on outbound mail within a single inbound-message turn. A
 * backstop against distinct-but-looping sends that the dedupe pass cannot catch.
 * Generous enough for legitimate multi-recipient fan-out.
 */
export const MAX_OUTBOUND_PER_TURN = 8;

type DefinedRunner = ToolRunner & { definitions: ToolDefinition[] };

export type GuardedMailRunner = DefinedRunner & { resetOutboundBudget(): void };

export type GuardedMailRunnerOptions = {
  maxOutboundPerTurn?: number;
};

function blocked(call: ToolCall, message: string): ToolResult {
  return { callId: call.id, content: { error: message }, isError: true };
}

function bodyOf(call: ToolCall): string {
  const content = call.arguments.content;
  return typeof content === 'string' ? content.trim() : '';
}

/**
 * Identify the recipient so dedupe is per-destination: mail_send carries `to`,
 * mail_reply targets the message `ref`. Keying on body alone would wrongly
 * suppress a legitimate fan-out of the same body to different recipients.
 */
function recipientOf(call: ToolCall): string {
  const to = call.arguments.to;
  if (typeof to === 'string') return to;
  return JSON.stringify(call.arguments.ref ?? '');
}

/**
 * Wrap a mail tool runner with a per-lifetime circuit breaker: suppress
 * byte-identical resends and cap total outbound volume, returning a structured
 * error the agent sees instead of letting a loop flood recipients. Read-only
 * mail tools (search/read/wait) pass through untouched. The harness resets
 * state on each inbound message, so a long-running agent does not exhaust the
 * guard across unrelated work.
 *
 * This is a runtime safety guard at the harness-composition seam, not a
 * product rule: it protects against loops from any cause (weak model, retry
 * storms, future bugs), which is why it lives here rather than relying on the
 * agent prompt to behave.
 */
export function createGuardedMailRunner(
  inner: DefinedRunner,
  options: GuardedMailRunnerOptions = {}
): GuardedMailRunner {
  const maxOutboundPerTurn = options.maxOutboundPerTurn ?? MAX_OUTBOUND_PER_TURN;
  let outboundCount = 0;
  const sentKeys = new Map<string, number>();

  return {
    definitions: inner.definitions,
    resetOutboundBudget() {
      outboundCount = 0;
      sentKeys.clear();
    },
    async run(call: ToolCall, signal: AbortSignal): Promise<ToolResult> {
      if (!MAIL_WRITE_TOOLS.has(call.name)) {
        return inner.run(call, signal);
      }

      if (outboundCount >= maxOutboundPerTurn) {
        logger.warn('Outbound mail cap reached for {tool}: {count} sent', {
          tool: call.name,
          count: outboundCount,
        });
        return blocked(
          call,
          `Outbound mail cap reached (${maxOutboundPerTurn} this turn). Stop sending — your turn is done.`
        );
      }

      const body = bodyOf(call);
      const key = `${recipientOf(call)}\u001f${body}`;
      const alreadySent = sentKeys.get(key) ?? 0;
      if (body.length > 0 && alreadySent >= MAX_IDENTICAL_OUTBOUND) {
        logger.warn('Suppressed duplicate outbound mail for {tool}', { tool: call.name });
        return blocked(
          call,
          'Duplicate outbound mail suppressed — you already sent this exact message to this recipient. Do not resend; your turn is done.'
        );
      }

      const result = await inner.run(call, signal);
      if (!result.isError) {
        outboundCount += 1;
        if (body.length > 0) sentKeys.set(key, alreadySent + 1);
      }
      return result;
    },
  };
}
