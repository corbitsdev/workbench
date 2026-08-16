import { describe, expect, test } from "bun:test";

import { createFakeCommandRunner } from "./fake-command-runner";

describe("createFakeCommandRunner", () => {
  test("records every invocation and returns the handler's result", async () => {
    const runner = createFakeCommandRunner(async () => ({
      stdout: "container-id\n",
      stderr: "",
      exitCode: 0,
    }));

    const result = await runner.run(["run", "-d", "alpine"]);

    expect(result).toEqual({ stdout: "container-id\n", stderr: "", exitCode: 0 });
    expect(runner.calls).toEqual([["run", "-d", "alpine"]]);
  });
});
