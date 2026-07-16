import { existsSync } from "node:fs";
import type { ConversationTurn, ContentBlock } from "@intx/types/runtime";
import { IsogitStore } from "@workbench/storage-isogit";
import type { AgentRepoStore, RepoId } from "@intx/hub-sessions";
import type { MomentTurnInputMessage } from "@workbench/timeline";

// Cap the commit walk. A turn older than the newest MAX_LOG_DEPTH commits
// cannot be aligned and returns an honest gap rather than a wrong snapshot.
const MAX_LOG_DEPTH = 10_000;

// The reactor commits one checkpoint per inference call, whose message is
// `checkpoint: inference-done` (or `inference-error` on a failed call). These
// are 1:1 with `inference_turn` rows and carry the turn's assistant output.
// Tool-execution / tool-done / gate-cleared checkpoints are NOT turn
// boundaries. (Reason vocabulary mirrors interchange's timeline reconstruction.)
const TERMINAL_INFERENCE_CHECKPOINT = /^checkpoint: inference-(done|error)\b/;

export type TurnInputSnapshot =
  | { messages: MomentTurnInputMessage[] }
  | { gap: string };

function floorToSecondMs(ms: number): number {
  return Math.floor(ms / 1000) * 1000;
}

/**
 * Flatten one `ConversationTurn`'s content blocks to render-ready text. Media
 * blocks collapse to a placeholder; redacted thinking (no readable payload) is
 * dropped. Every block type that carries readable content is projected so the
 * input rendering is not silently incomplete.
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
      case "citation":
        parts.push(`[citation] ${block.citedText}`);
        break;
      case "code_execution_request":
        parts.push(`[code]\n${block.code}`);
        break;
      case "code_execution_result": {
        const out = [block.stdout, block.stderr].filter(Boolean).join("\n");
        parts.push(`[code result: ${block.status}]${out ? `\n${out}` : ""}`);
        break;
      }
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

function collectTerminalPositions(
  commits: readonly { message: string }[],
): number[] {
  const terminals: number[] = [];
  for (let i = 0; i < commits.length; i += 1) {
    const commit = commits[i];
    if (
      commit !== undefined &&
      TERMINAL_INFERENCE_CHECKPOINT.test(commit.message)
    ) {
      terminals.push(i);
    }
  }
  return terminals;
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

// The turn's own assistant output is the trailing assistant turn(s) in its
// terminal checkpoint. Everything up to (and including) the triggering
// user/tool-result message is the input the model received.
function dropTrailingAssistantOutput(
  turns: ConversationTurn[],
): ConversationTurn[] {
  let end = turns.length;
  while (end > 0 && turns[end - 1]?.role === "assistant") {
    end -= 1;
  }
  return turns.slice(0, end);
}

/**
 * Read the conversation the model received as INPUT for an inference turn from
 * the hub-durable agent-state repo. The sidecar commits one `inference-done`
 * checkpoint per turn (the triggering message and the assistant output land in
 * the SAME commit — there is no separate message checkpoint), so the input is
 * that checkpoint's `turns.jsonl` with this turn's trailing assistant output
 * removed. The turn is located by ordinal from the newest end of the log
 * (`laterTurnCount` = how many of the instance's turns started after this one),
 * which is robust to the second-granular git author timestamps that make a
 * pure time comparison unsafe for sub-second turns.
 *
 * All failure modes — the state repo was never pushed (or was reaped
 * sidecar-side), the turn falls outside the retained log window, or the
 * checkpoint cannot be aligned/read — resolve to an honest `{ gap }`, never a
 * fabricated or wrong-turn snapshot.
 */
export async function readTurnInputSnapshot(
  repoStore: AgentRepoStore,
  args: { address: string; startedAtMs: number; laterTurnCount: number },
): Promise<TurnInputSnapshot> {
  const repoId: RepoId = { kind: "agent-state", id: args.address };
  const dir = repoStore.repoStore.getRepoDir(repoId);
  if (!existsSync(dir)) {
    return { gap: "The conversation store for this agent is not available." };
  }

  const store = new IsogitStore(dir);

  // `log` returns newest-first; the terminal checkpoints in that order are the
  // instance's turns newest-first, so the turn with `laterTurnCount` turns
  // after it is at that index. Walk only as deep as needed to reach it — a
  // recent turn costs a small read, not an O(history) walk — and fall back to
  // the full window only when the estimate proves too shallow to contain it.
  const estimate = Math.min(MAX_LOG_DEPTH, (args.laterTurnCount + 1) * 8 + 16);
  let commits;
  let terminals: number[];
  try {
    commits = await store.log(estimate);
    terminals = collectTerminalPositions(commits);
    if (
      terminals.length <= args.laterTurnCount &&
      commits.length >= estimate &&
      estimate < MAX_LOG_DEPTH
    ) {
      commits = await store.log(MAX_LOG_DEPTH);
      terminals = collectTerminalPositions(commits);
    }
  } catch {
    return { gap: "The conversation history could not be read." };
  }

  const terminalPos = terminals[args.laterTurnCount];
  if (terminalPos === undefined) {
    return {
      gap: "The input for this turn is outside the retained conversation history (it may have been compacted or exceeds the history window).",
    };
  }

  const terminal = commits[terminalPos];
  if (
    terminal === undefined ||
    terminal.timestamp < floorToSecondMs(args.startedAtMs)
  ) {
    return {
      gap: "The input for this turn could not be reliably aligned to the recorded history.",
    };
  }

  let turns: ConversationTurn[];
  try {
    turns = await store.readAt(terminal.hash);
  } catch {
    return {
      gap: "The conversation snapshot for this turn could not be read.",
    };
  }

  return {
    messages: dropTrailingAssistantOutput(turns).map(projectTurn),
  };
}
