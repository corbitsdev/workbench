import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import git from "isomorphic-git";
import { createIsogitStore } from "@workbench/storage-isogit";
import type { ConversationTurn } from "@intx/types/runtime";
import type { AgentRepoStore } from "@intx/hub-sessions";

import { readTurnInputSnapshot } from "./turn-input-snapshot";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    dirs
      .splice(0)
      .map((d) => fs.promises.rm(d, { recursive: true, force: true })),
  );
});

async function tempDir(): Promise<string> {
  const d = await fs.promises.mkdtemp(path.join(os.tmpdir(), "cl3786-"));
  dirs.push(d);
  return d;
}

function textTurn(
  role: ConversationTurn["role"],
  text: string,
): ConversationTurn {
  return { role, content: [{ type: "text", text }], timestamp: 0 };
}

function toolResultTurn(text: string): ConversationTurn {
  return {
    role: "user",
    content: [
      {
        type: "tool_result",
        callId: "c1",
        content: [{ type: "text", text }],
      },
    ],
    timestamp: 0,
  };
}

// Commit `turns.jsonl` at a controlled author time so the reader's
// "newest commit at or before the turn start" selection is deterministic.
async function commitAt(
  dir: string,
  turns: ConversationTurn[],
  tsSeconds: number,
): Promise<void> {
  await fs.promises.writeFile(
    path.join(dir, "turns.jsonl"),
    turns.map((t) => JSON.stringify(t)).join("\n") + "\n",
  );
  await git.add({ fs, dir, filepath: "turns.jsonl" });
  await git.commit({
    fs,
    dir,
    message: "checkpoint: inference-done",
    author: {
      name: "sidecar",
      email: "sidecar@interchange.local",
      timestamp: tsSeconds,
      timezoneOffset: 0,
    },
  });
}

function repoStoreForDir(dir: string): AgentRepoStore {
  return {
    repoStore: { getRepoDir: () => dir },
  } as unknown as AgentRepoStore;
}

describe("readTurnInputSnapshot", () => {
  test("returns the conversation committed at or before the turn start", async () => {
    const dir = await tempDir();
    await createIsogitStore(dir);
    // C1 @1000s: system + first user message (input to turn 1).
    await commitAt(
      dir,
      [textTurn("system", "You are Myra."), textTurn("user", "hi")],
      1000,
    );
    // C2 @2000s: turn 1's assistant output + a tool result landed
    // (this is the input to turn 2).
    await commitAt(
      dir,
      [
        textTurn("system", "You are Myra."),
        textTurn("user", "hi"),
        textTurn("assistant", "hello"),
        toolResultTurn('{"ok":true}'),
      ],
      2000,
    );
    // C3 @3000s: turn 2's assistant output.
    await commitAt(
      dir,
      [
        textTurn("system", "You are Myra."),
        textTurn("user", "hi"),
        textTurn("assistant", "hello"),
        toolResultTurn('{"ok":true}'),
        textTurn("assistant", "second"),
      ],
      3000,
    );

    // Turn 2 started at 2500s — its input is the C2 snapshot, not C3.
    const result = await readTurnInputSnapshot(repoStoreForDir(dir), {
      address: "myra@t",
      startedAtMs: 2500 * 1000,
    });

    expect("messages" in result).toBe(true);
    if (!("messages" in result)) return;
    expect(result.messages.map((m) => m.text)).toEqual([
      "You are Myra.",
      "hi",
      "hello",
      '{"ok":true}',
    ]);
    expect(result.messages[0]?.role).toBe("system");
    expect(result.messages[3]?.kind).toBe("tool_result");
  });

  test("gaps honestly when no snapshot precedes the turn", async () => {
    const dir = await tempDir();
    await createIsogitStore(dir);
    await commitAt(dir, [textTurn("user", "hi")], 5000);

    const result = await readTurnInputSnapshot(repoStoreForDir(dir), {
      address: "myra@t",
      startedAtMs: 1000 * 1000,
    });

    expect("gap" in result).toBe(true);
    if (!("gap" in result)) return;
    expect(result.gap).toContain("No conversation snapshot");
  });

  test("gaps honestly when the agent-state repo does not exist", async () => {
    const missing = path.join(await tempDir(), "nope");
    const result = await readTurnInputSnapshot(repoStoreForDir(missing), {
      address: "myra@t",
      startedAtMs: 2500 * 1000,
    });

    expect("gap" in result).toBe(true);
    if (!("gap" in result)) return;
    expect(result.gap).toContain("not available");
  });
});
