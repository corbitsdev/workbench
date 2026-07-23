import fs, { existsSync } from "node:fs";
import git from "isomorphic-git";
import { getLogger } from "@intx/log";
import type { ConversationTurn, ContentBlock } from "@intx/types/runtime";
import { IsogitStore } from "@workbench/storage-isogit";
import type { AgentRepoStore, RepoId } from "@workbench/hub-sessions";
import type { MomentTurnInputMessage } from "@workbench/timeline";

const log = getLogger(["hub", "turn-input-snapshot"]);

// Cap the commit walk. A turn older than the newest MAX_LOG_DEPTH commits
// cannot be aligned and returns an honest gap rather than a wrong snapshot.
const MAX_LOG_DEPTH = 10_000;

// INTERCHANGE SEAM (pin-bump audit): this read depends on two upstream reactor
// behaviours that will not surface at compile time —
//   (1) the reactor writes the fully-assembled prompt (after any pre-inference
//       context transforms) to `prompt.jsonl` and commits it in the SAME
//       `inference-done` checkpoint as the turn it belongs to, and
//   (2) exactly one `inference-done` checkpoint is committed per completed
//       `inference_turn` row.
// If either changes upstream, this can serve a stale/wrong prompt with a green
// build — re-verify on every interchange pin bump.
const PROMPT_FILE = "prompt.jsonl";

// The reactor commits one `checkpoint: inference-done` per COMPLETED inference
// call; these are 1:1 with completed `inference_turn` rows and carry that
// turn's assembled prompt. `inference-error` (failed/aborted) and
// tool-execution / tool-done / gate-cleared checkpoints are deliberately NOT
// matched — an error checkpoint has no completed row and would otherwise shift
// the ordinal alignment.
const TERMINAL_INFERENCE_CHECKPOINT = /^checkpoint: inference-done\b/;

// A pathological turn (a huge tool output echoed into the prompt) must not
// balloon the detail response. Cap each projected message's text.
const MAX_MESSAGE_CHARS = 20_000;

// The turn's `inference-done` checkpoint is authored when the turn's inference
// completes (~`ended_at`), plus commit latency. Bound the accepted checkpoint to
// `ended_at` + this slack so an ordinal that lands on a different turn's
// checkpoint fails to an honest gap instead of a wrong prompt.
const COMMIT_LATENCY_SLACK_MS = 60_000;

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
  const text = parts.join("\n").trim();
  return text.length > MAX_MESSAGE_CHARS
    ? `${text.slice(0, MAX_MESSAGE_CHARS)}…[truncated]`
    : text;
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

// `prompt.jsonl` is JSONL — one `ConversationTurn` per line. Keep only the
// lines that parse into a turn shape; a malformed line is skipped rather than
// failing the whole read.
function parsePromptTurns(text: string): ConversationTurn[] {
  const turns: ConversationTurn[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "role" in parsed &&
      Array.isArray((parsed as { content?: unknown }).content)
    ) {
      turns.push(parsed as ConversationTurn);
    }
  }
  return turns;
}

/**
 * Read the exact prompt the model received for an inference turn from the
 * hub-durable agent-state repo. The reactor persists that assembled prompt to
 * `prompt.jsonl` every cycle and commits it with the turn's `inference-done`
 * checkpoint, so the input is read directly from that file at that commit — no
 * reconstruction from the durable conversation. The turn is located by ordinal
 * from the newest end of the log (`laterTurnCount` = how many of the instance's
 * turns started after this one), which is robust to the second-granular git
 * author timestamps that make a pure time comparison unsafe for sub-second
 * turns.
 *
 * All failure modes — the state repo was never pushed (or was reaped
 * sidecar-side), the turn falls outside the retained log window, or the
 * checkpoint cannot be aligned/read — resolve to an honest `{ gap }`, never a
 * fabricated or wrong-turn snapshot.
 */
export async function readTurnInputSnapshot(
  repoStore: AgentRepoStore,
  args: {
    address: string;
    startedAtMs: number;
    endedAtMs: number;
    laterTurnCount: number;
  },
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
      log.info(
        "turn input: estimate {estimate} too shallow for {address}; walking full history",
        { estimate, address: args.address },
      );
      commits = await store.log(MAX_LOG_DEPTH);
      terminals = collectTerminalPositions(commits);
    }
  } catch {
    return { gap: "The conversation history could not be read." };
  }

  const terminalPos = terminals[args.laterTurnCount];
  if (terminalPos === undefined) {
    return {
      gap: "The input for this turn is outside the retained conversation history window.",
    };
  }

  // The turn's own checkpoint is authored within its [started_at, ended_at]
  // span (plus commit latency). A checkpoint outside that window means the
  // ordinal landed on a different turn — surface an honest gap, never a wrong
  // prompt.
  const terminal = commits[terminalPos];
  if (
    terminal === undefined ||
    terminal.timestamp < floorToSecondMs(args.startedAtMs) ||
    terminal.timestamp >
      floorToSecondMs(args.endedAtMs) + COMMIT_LATENCY_SLACK_MS
  ) {
    return {
      gap: "The input for this turn could not be reliably aligned to the recorded history.",
    };
  }

  let blob: Uint8Array;
  try {
    ({ blob } = await git.readBlob({
      fs,
      dir,
      oid: terminal.hash,
      filepath: PROMPT_FILE,
    }));
  } catch {
    return { gap: "The recorded input for this turn is not available." };
  }

  const turns = parsePromptTurns(new TextDecoder().decode(blob));
  if (turns.length === 0) {
    return { gap: "The recorded input for this turn is not available." };
  }
  return { messages: turns.map(projectTurn) };
}
