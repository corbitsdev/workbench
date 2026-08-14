/**
 * Chat SDK `StateAdapter` resolution for workbench's Slack mount.
 *
 * Lifted from the `resolveThreadState` pattern in scout's
 * `packages/agent-dock/src/tag-mount.ts` (CL-4973): try to connect the
 * given adapter (typically a durable one); fall back to an in-memory
 * adapter so a backend hiccup at mount time doesn't take down Slack tag
 * ingress — it just means subscription/dedup/lock state won't survive
 * the next restart until the backend comes back. Which adapter to try
 * first is entirely the caller's business; this only owns the
 * connect-or-fall-back policy.
 *
 * This is `corbits-tag/slack`'s own internal state (thread
 * subscriptions, dedup, locks) — a different concern from
 * `SlackChannelBindingStore` (`./store.ts`), which is this package's
 * own durable "Slack channel -> workbench channel" record.
 */
import { createMemoryState } from "@chat-adapter/state-memory";
import type { StateAdapter } from "chat";
import { getLogger } from "@intx/log";

const log = getLogger(["slack-tag", "thread-state"]);

export async function resolveThreadState(
  adapter: StateAdapter,
): Promise<StateAdapter> {
  try {
    await adapter.connect();
    return adapter;
  } catch (cause) {
    log.error(
      "Durable thread-state connect failed, falling back to in-memory state: {error}",
      { error: cause instanceof Error ? cause.message : String(cause) },
    );
    return createMemoryState();
  }
}
