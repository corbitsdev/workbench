import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import git from "isomorphic-git";
import { createIsogitStore } from "@workbench/storage-isogit";
import type { ConversationTurn } from "@intx/types/runtime";
import type { AgentRepoStore } from "@workbench/hub-sessions";

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

// Commit `prompt.jsonl` under a given checkpoint message at a controlled author
// time.
async function commitCheckpoint(
  dir: string,
  message: string,
  promptTurns: ConversationTurn[],
  tsSeconds: number,
): Promise<void> {
  await fs.promises.writeFile(
    path.join(dir, "prompt.jsonl"),
    promptTurns.map((t) => JSON.stringify(t)).join("\n") + "\n",
  );
  await git.add({ fs, dir, filepath: "prompt.jsonl" });
  await git.commit({
    fs,
    dir,
    message,
    author: {
      name: "sidecar",
      email: "sidecar@interchange.local",
      timestamp: tsSeconds,
      timezoneOffset: 0,
    },
  });
}

// A completed turn's `inference-done` checkpoint; `prompt.jsonl` holds exactly
// the input that turn received.
async function commitTurnCheckpoint(
  dir: string,
  promptTurns: ConversationTurn[],
  tsSeconds: number,
): Promise<void> {
  await commitCheckpoint(
    dir,
    "checkpoint: inference-done",
    promptTurns,
    tsSeconds,
  );
}

function repoStoreForDir(dir: string): AgentRepoStore {
  return {
    repoStore: { getRepoDir: () => dir },
  } as unknown as AgentRepoStore;
}

// A two-turn conversation: turn 1 (q1 → a1) then turn 2 (q2 → a2). Each
// checkpoint records the prompt that turn received — the assistant answer is
// never part of a turn's own input prompt.
async function seedTwoTurnRepo(dir: string): Promise<void> {
  await createIsogitStore(dir);
  // Turn 1 input: system + first question.
  await commitTurnCheckpoint(
    dir,
    [textTurn("system", "You are Myra."), textTurn("user", "q1")],
    1000,
  );
  // Turn 2 input: the conversation so far (incl. turn 1's answer) + q2.
  await commitTurnCheckpoint(
    dir,
    [
      textTurn("system", "You are Myra."),
      textTurn("user", "q1"),
      textTurn("assistant", "a1"),
      textTurn("user", "q2"),
    ],
    2000,
  );
}

describe("readTurnInputSnapshot", () => {
  test("returns the input up to the triggering message, stripping the turn's own output", async () => {
    const dir = await tempDir();
    await seedTwoTurnRepo(dir);

    // Turn 2 is the newest (0 turns after it), started shortly before its
    // output committed.
    const result = await readTurnInputSnapshot(repoStoreForDir(dir), {
      address: "myra@t",
      startedAtMs: 1999 * 1000 + 500,
      endedAtMs: 2000 * 1000,
      laterTurnCount: 0,
    });

    expect("messages" in result).toBe(true);
    if (!("messages" in result)) return;
    expect(result.messages.map((m) => m.text)).toEqual([
      "You are Myra.",
      "q1",
      "a1",
      "q2",
    ]);
    // The turn's own answer is never shown as its input.
    expect(result.messages.some((m) => m.text === "a2")).toBe(false);
  });

  test("skips an interleaved inference-error checkpoint (no ordinal shift)", async () => {
    const dir = await tempDir();
    await createIsogitStore(dir);
    // turn 1 completes, then a failed inference commits an error checkpoint,
    // then turn 2 completes. Only inference-done checkpoints align, so the
    // error checkpoint must not shift turn 2's ordinal.
    await commitTurnCheckpoint(
      dir,
      [textTurn("system", "You are Myra."), textTurn("user", "q1")],
      1000,
    );
    await commitCheckpoint(
      dir,
      "checkpoint: inference-error",
      [textTurn("system", "You are Myra."), textTurn("user", "q1")],
      1500,
    );
    await commitTurnCheckpoint(
      dir,
      [
        textTurn("system", "You are Myra."),
        textTurn("user", "q1"),
        textTurn("assistant", "a1"),
        textTurn("user", "q2"),
      ],
      2000,
    );

    const result = await readTurnInputSnapshot(repoStoreForDir(dir), {
      address: "myra@t",
      startedAtMs: 1999 * 1000 + 500,
      endedAtMs: 2000 * 1000,
      laterTurnCount: 0,
    });

    expect("messages" in result).toBe(true);
    if (!("messages" in result)) return;
    expect(result.messages.map((m) => m.text)).toEqual([
      "You are Myra.",
      "q1",
      "a1",
      "q2",
    ]);
  });

  test("gaps when the aligned checkpoint falls outside the turn's time span", async () => {
    const dir = await tempDir();
    await seedTwoTurnRepo(dir);

    // Claim a turn whose span ended long before the aligned checkpoint was
    // authored — the window guard must reject it rather than serve a wrong turn.
    const result = await readTurnInputSnapshot(repoStoreForDir(dir), {
      address: "myra@t",
      startedAtMs: 100 * 1000,
      endedAtMs: 200 * 1000,
      laterTurnCount: 0,
    });

    expect("gap" in result).toBe(true);
    if (!("gap" in result)) return;
    expect(result.gap).toContain("could not be reliably aligned");
  });

  test("does not leak the turn's own output when the turn is sub-second (Finding 1)", async () => {
    const dir = await tempDir();
    await seedTwoTurnRepo(dir);

    // The turn started later in the SAME wall-clock second its output commit is
    // authored — the exact case second-granular timestamps get wrong.
    const result = await readTurnInputSnapshot(repoStoreForDir(dir), {
      address: "myra@t",
      startedAtMs: 2000 * 1000 + 400,
      endedAtMs: 2000 * 1000 + 800,
      laterTurnCount: 0,
    });

    expect("messages" in result).toBe(true);
    if (!("messages" in result)) return;
    expect(result.messages.some((m) => m.text === "a2")).toBe(false);
    expect(result.messages.some((m) => m.text === "q2")).toBe(true);
  });

  test("locates an earlier turn by its ordinal from the newest end", async () => {
    const dir = await tempDir();
    await seedTwoTurnRepo(dir);

    // Turn 1 has one turn after it.
    const result = await readTurnInputSnapshot(repoStoreForDir(dir), {
      address: "myra@t",
      startedAtMs: 999 * 1000,
      endedAtMs: 1000 * 1000,
      laterTurnCount: 1,
    });

    expect("messages" in result).toBe(true);
    if (!("messages" in result)) return;
    expect(result.messages.map((m) => m.text)).toEqual(["You are Myra.", "q1"]);
  });

  test("gaps honestly when the turn is beyond the retained checkpoints", async () => {
    const dir = await tempDir();
    await seedTwoTurnRepo(dir);

    const result = await readTurnInputSnapshot(repoStoreForDir(dir), {
      address: "myra@t",
      startedAtMs: 2000 * 1000,
      endedAtMs: 2000 * 1000,
      laterTurnCount: 5,
    });

    expect("gap" in result).toBe(true);
    if (!("gap" in result)) return;
    expect(result.gap).toContain("outside the retained");
  });

  test("gaps honestly when the agent-state repo does not exist", async () => {
    const missing = path.join(await tempDir(), "nope");
    const result = await readTurnInputSnapshot(repoStoreForDir(missing), {
      address: "myra@t",
      startedAtMs: 2000 * 1000,
      endedAtMs: 2000 * 1000,
      laterTurnCount: 0,
    });

    expect("gap" in result).toBe(true);
    if (!("gap" in result)) return;
    expect(result.gap).toContain("not available");
  });
});
