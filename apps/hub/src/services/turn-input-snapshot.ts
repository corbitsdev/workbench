import { existsSync } from "node:fs";
import type { ConversationTurn, ContentBlock } from "@intx/types/runtime";
import { IsogitStore } from "@workbench/storage-isogit";
import type { AgentRepoStore, RepoId } from "@intx/hub-sessions";
import type { MomentTurnInputMessage } from "@workbench/timeline";

// Cap the commit walk. A very long-lived agent's state log can exceed this;
// when the pre-turn snapshot falls outside the window we return an honest gap
// rather than a wrong (too-recent) snapshot.
const MAX_LOG_DEPTH = 10_000;

export type TurnInputSnapshot =
  | { messages: MomentTurnInputMessage[] }
  | { gap: string };

/**
 * Flatten one `ConversationTurn`'s content blocks to render-ready text. Media
 * blocks (image/audio/video/document) collapse to a placeholder — the trace
 * shows the conversation shape the model saw, not the raw bytes.
 */
function projectBlocks(blocks: ContentBlock[]): string {
  const parts: string[] = [];
  for (const block of blocks) {
    switch (block.type) {
      case "text":
        parts.push(block.text);
        break;
      case "thinking":
        parts.push(block.thinking);
        break;
      case "refusal":
        parts.push(block.reason);
        break;
      case "tool_call":
        parts.push(
          `[tool_call ${block.name}] ${JSON.stringify(block.arguments)}`,
        );
        break;
      case "tool_result":
        parts.push(projectBlocks(block.content));
        break;
      case "image":
      case "audio":
      case "video":
      case "document":
        parts.push(`[${block.type}]`);
        break;
      default:
        break;
    }
  }
  return parts.join("\n").trim();
}

function isToolResultTurn(turn: ConversationTurn): boolean {
  return turn.content[0]?.type === "tool_result";
}

function projectTurn(turn: ConversationTurn): MomentTurnInputMessage {
  return {
    role: turn.role,
    kind: isToolResultTurn(turn) ? "tool_result" : "message",
    text: projectBlocks(turn.content),
  };
}

/**
 * Read the conversation the model received as INPUT for an inference turn from
 * the hub-durable agent-state repo. The sidecar commits each conversation
 * checkpoint to `turns.jsonl` (git author time ~= the Postgres timestamps,
 * since both originate in the same sidecar process), so the input snapshot is
 * the conversation at the latest commit whose author time is at or before the
 * turn's `startedAt`: the turn's own assistant output commits later (at
 * `endedAt`), and any tool results it consumed were committed in their own
 * checkpoint before it began.
 *
 * All failure modes — the state repo was never pushed (or was reaped
 * sidecar-side), history was pruned by compaction, or no snapshot precedes the
 * turn — resolve to an honest `{ gap }`, never a fabricated snapshot.
 */
export async function readTurnInputSnapshot(
  repoStore: AgentRepoStore,
  args: { address: string; startedAtMs: number },
): Promise<TurnInputSnapshot> {
  const repoId: RepoId = { kind: "agent-state", id: args.address };
  const dir = repoStore.repoStore.getRepoDir(repoId);
  if (!existsSync(dir)) {
    return { gap: "The conversation store for this agent is not available." };
  }

  const store = new IsogitStore(dir);
  let commits;
  try {
    commits = await store.log(MAX_LOG_DEPTH);
  } catch {
    return { gap: "The conversation history could not be read." };
  }

  // `log` returns newest-first. The input snapshot is the newest commit at or
  // before the turn's start.
  const snapshot = commits.find((c) => c.timestamp <= args.startedAtMs);
  if (snapshot === undefined) {
    return {
      gap: "No conversation snapshot precedes this turn; the earlier history may have been compacted away.",
    };
  }

  let turns: ConversationTurn[];
  try {
    turns = await store.readAt(snapshot.hash);
  } catch {
    return {
      gap: "The conversation snapshot for this turn could not be read.",
    };
  }

  return { messages: turns.map(projectTurn) };
}
