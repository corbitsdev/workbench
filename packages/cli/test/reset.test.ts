import { describe, expect, test } from "bun:test";
import { runReset } from "../src/reset";
import { collector } from "./helpers";

describe("runReset", () => {
  test("runs the reset and reports what to do next", async () => {
    const { lines, log } = collector();
    let ran = 0;
    await runReset({
      runReset: async () => {
        ran += 1;
      },
      log,
    });
    expect(ran).toBe(1);
    const output = lines.join("\n");
    expect(output).toContain("resetting local state");
    expect(output).toContain("reset complete. next: bun run dev");
    expect(output).toContain("workbench setup && workbench seed");
  });

  test("a failing reset propagates without reporting completion", async () => {
    const { lines, log } = collector();
    const failing = async () => {
      throw new Error("database unreachable");
    };
    await expect(runReset({ runReset: failing, log })).rejects.toThrow(
      "database unreachable",
    );
    expect(lines.join("\n")).not.toContain("reset complete");
  });
});
