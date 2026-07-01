// End-to-end exercise of the Bun.spawn-backed `defaultSubprocessSpawner`
// the wiring module exports. The supervisor's `wireChild` consumes
// four behaviours from the handle:
//
//   1. The control channel surfaces NDJSON lines the child writes
//      to its upstream control fd (CL-2585: fd 5, not stdout). A real
//      child writes a signed `ready` envelope here; the test stub
//      writes a sentinel NDJSON line.
//   2. The handle's `exited` future resolves with the child's
//      terminal exit code so the supervisor can race spawn-time
//      crashes against `readyPromise`.
//   3. A `Bun.spawn` that fails immediately (binary missing) settles
//      `exited` with a non-zero code rapidly enough for that race
//      to fire.
//   4. The child's runtime env is exactly the supervisor-supplied
//      env -- unrelated `process.env` entries do not leak in.
//
// CL-2585: the control channel rides dedicated fds (4 down, 5 up) so
// the child's stdout/stderr are free for logs. The child fixtures
// below write upstream control frames to fd 5; a regression test
// asserts a stray non-JSON line on the child's stdout never reaches
// the supervisor's control reader (the bug that crashed the channel
// and produced reason=corrupt).

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { defaultSubprocessSpawner } from "./workflow-host-wiring";

let tmpRoot: string;

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "intx-spawner-test-"));
});

afterAll(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

async function writeChildScript(body: string): Promise<string> {
  const file = path.join(tmpRoot, `child-${String(Date.now())}.ts`);
  await fs.writeFile(file, body, "utf-8");
  return file;
}

describe("defaultSubprocessSpawner (Bun.spawn-backed)", () => {
  test("surfaces the child's NDJSON output on controlReader and resolves exited with the exit code", async () => {
    // Inline child:
    //   - reads CHILD_TOKEN out of the env and echoes it
    //   - reads SHOULD_NOT_LEAK to prove env isolation (not set by
    //     this test's spawner call, so the child must observe it
    //     as the sentinel string)
    //   - writes one byte sequence to fd 3 (event channel)
    //   - emits one NDJSON control frame on fd 5 (upstream control;
    //     CL-2585 moved this off stdout)
    //   - exits 0
    const childScript = `
import fs from "node:fs";
const token = process.env.CHILD_TOKEN ?? "MISSING";
const leaked = process.env.SHOULD_NOT_LEAK ?? "UNSET";
const event = new TextEncoder().encode("event-byte");
const eventStream = fs.createWriteStream("", { fd: 3 });
const controlUp = fs.createWriteStream("", { fd: 5 });
eventStream.write(event, () => {
  controlUp.write(
    JSON.stringify({ probe: "ready", token, leaked }) + "\\n",
    () => process.exit(0),
  );
});
`;
    const scriptPath = await writeChildScript(childScript);

    // The wiring module's spawner is a bare Bun.spawn binding; the
    // production callsite invokes the binary directly. The script
    // path here points to a TypeScript file which requires Bun's
    // shebang to execute; the production binary at
    // `apps/sidecar/bin/workflow-child` is `#!/usr/bin/env bun`,
    // so the wiring module spawns it as a bare argv entry. The
    // test mirrors that by routing the spawn through a tiny
    // wrapper script that points at Bun's runtime.
    const wrapperPath = path.join(tmpRoot, `wrapper-${String(Date.now())}.sh`);
    await fs.writeFile(
      wrapperPath,
      `#!/bin/sh\nexec "${process.execPath}" "${scriptPath}"\n`,
      "utf-8",
    );
    await fs.chmod(wrapperPath, 0o755);

    // Set SHOULD_NOT_LEAK on the test process; the spawner must NOT
    // forward it to the child because the env arg below excludes
    // it. The child observes the unset variable as "UNSET".
    process.env.SHOULD_NOT_LEAK = "leaked";
    try {
      const handle = defaultSubprocessSpawner({
        binaryPath: wrapperPath,
        env: { CHILD_TOKEN: "spawner-test-value" },
      });

      const ctrlIter = handle.controlReader.read();
      const first = await ctrlIter.next();
      expect(first.done).toBeFalsy();
      if (first.value === undefined) {
        throw new Error("control reader yielded undefined first value");
      }
      const parsed: unknown = JSON.parse(first.value);
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        !("probe" in parsed) ||
        !("token" in parsed) ||
        !("leaked" in parsed)
      ) {
        throw new Error(
          `child NDJSON payload missing expected fields: ${JSON.stringify(parsed)}`,
        );
      }
      expect(parsed.probe).toBe("ready");
      expect(parsed.token).toBe("spawner-test-value");
      expect(parsed.leaked).toBe("UNSET");

      // Drain one frame off the event channel. The child wrote one
      // byte sequence to fd 3 before exiting; the supervisor's
      // FrameReader contract yields one Uint8Array per kernel-
      // delivered chunk.
      const eventIter = handle.eventReader.read();
      const chunk = await eventIter.next();
      expect(chunk.done).toBeFalsy();
      if (chunk.value === undefined) {
        throw new Error("event reader yielded undefined value");
      }
      expect(new TextDecoder().decode(chunk.value)).toBe("event-byte");

      const code = await handle.exited;
      expect(code).toBe(0);
    } finally {
      delete process.env.SHOULD_NOT_LEAK;
    }
  });

  test("spawn-time failure surfaces fast enough for the supervisor's readyPromise race", async () => {
    // The supervisor's `wireChild` races `handle.exited` against
    // the child's `readyPromise`. A child that fails to reach
    // `ready` (the production binary's failure mode for malformed
    // env: throws in `parseSpawnTimeEnv` before opening the
    // control channel) must surface as `exited` settling with a
    // non-zero code -- otherwise the supervisor wedges in
    // `starting`. The inline child below exits 1 without writing
    // a single byte; the spawner's `exited` future must observe
    // the terminal code.
    const childScript = `process.exit(7);`;
    const scriptPath = await writeChildScript(childScript);
    const wrapperPath = path.join(
      tmpRoot,
      `wrapper-fail-${String(Date.now())}.sh`,
    );
    await fs.writeFile(
      wrapperPath,
      `#!/bin/sh\nexec "${process.execPath}" "${scriptPath}"\n`,
      "utf-8",
    );
    await fs.chmod(wrapperPath, 0o755);

    const handle = defaultSubprocessSpawner({
      binaryPath: wrapperPath,
      env: {},
    });
    const code = await handle.exited;
    expect(code).toBe(7);
  });

  test("Bun.spawn synchronous throws on a missing binary surface to the caller", () => {
    // The other half of the spawn-time race: a binary path that
    // does not exist on disk surfaces as a synchronous throw from
    // `Bun.spawn`, which the supervisor's `spawn(opts)` propagates
    // to its caller. The supervisor never reaches the
    // readyPromise race in this branch; the throw IS the failure
    // signal. Pin the synchronous-throw behaviour here so a future
    // Bun release that swaps to an async failure mode does not
    // silently change the supervisor's spawn-error surface.
    expect(() => {
      defaultSubprocessSpawner({
        binaryPath: "/nonexistent-binary-for-spawner-test",
        env: {},
      });
    }).toThrow();
  });

  test("kill() forwards the recycle path's SIGTERM and SIGKILL signals", async () => {
    // The supervisor's recycle path calls `handle.kill("SIGTERM")`
    // and then `handle.kill("SIGKILL")`. Assert both crossings
    // succeed; the bytes the supervisor sends are these exact
    // strings.
    const childScript = `
import fs from "node:fs";
const controlUp = fs.createWriteStream("", { fd: 5 });
controlUp.write(JSON.stringify({ probe: "ready" }) + "\\n");
const eventStream = fs.createWriteStream("", { fd: 3 });
void eventStream;
await new Promise((r) => setTimeout(r, 5000));
process.exit(0);
`;
    const scriptPath = await writeChildScript(childScript);
    const wrapperPath = path.join(
      tmpRoot,
      `wrapper-kill-${String(Date.now())}.sh`,
    );
    await fs.writeFile(
      wrapperPath,
      `#!/bin/sh\nexec "${process.execPath}" "${scriptPath}"\n`,
      "utf-8",
    );
    await fs.chmod(wrapperPath, 0o755);

    const handle = defaultSubprocessSpawner({
      binaryPath: wrapperPath,
      env: {},
    });

    const iter = handle.controlReader.read();
    const ready = await iter.next();
    expect(ready.done).toBeFalsy();

    handle.kill("SIGTERM");
    handle.kill("SIGKILL");

    const code = await handle.exited;
    expect(typeof code).toBe("number");
  });

  test("CL-2585: a stray ANSI log line on the child's stdout never reaches the control reader", async () => {
    // The regression. Before CL-2585 the upstream control channel WAS
    // the child's stdout, so a single `@intx/log` INFO line (ANSI-
    // colored, leading `\\x1B`) interleaved into the NDJSON control
    // stream and crashed the supervisor's control reader with "control
    // channel received non-JSON line" -> onChildCrash -> reason=corrupt.
    //
    // The child below emits the staging-exact ANSI INFO line on stdout
    // FIRST, then a healthy control frame on the dedicated upstream
    // control fd (5). With control isolated on fd 5, the supervisor's
    // controlReader must yield exactly the healthy frame and never the
    // log line. On the pre-fix wiring (control on stdout) this test
    // fails: the reader's first line is the ANSI log line, not JSON.
    const ansiLog =
      "\\x1B[32mINF\\x1B[0m \\x1B[2m2026-06-30 04:22:01\\x1B[0m step started";
    const childScript = `
import fs from "node:fs";
// stray log line on stdout BEFORE the control frame
process.stdout.write("${ansiLog}\\n");
const controlUp = fs.createWriteStream("", { fd: 5 });
const eventStream = fs.createWriteStream("", { fd: 3 });
void eventStream;
controlUp.write(
  JSON.stringify({ probe: "ready", marker: "healthy-frame" }) + "\\n",
  () => process.exit(0),
);
`;
    const scriptPath = await writeChildScript(childScript);
    const wrapperPath = path.join(
      tmpRoot,
      `wrapper-corrupt-${String(Date.now())}.sh`,
    );
    await fs.writeFile(
      wrapperPath,
      `#!/bin/sh\nexec "${process.execPath}" "${scriptPath}"\n`,
      "utf-8",
    );
    await fs.chmod(wrapperPath, 0o755);

    const handle = defaultSubprocessSpawner({
      binaryPath: wrapperPath,
      env: {},
    });

    const iter = handle.controlReader.read();
    const first = await iter.next();
    expect(first.done).toBeFalsy();
    if (first.value === undefined) {
      throw new Error("control reader yielded undefined first value");
    }
    // The very first line the control reader sees must be the healthy
    // JSON frame -- not the ANSI log line. A non-JSON line here is the
    // exact corruption CL-2585 fixes.
    const parsed: unknown = JSON.parse(first.value);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("marker" in parsed)
    ) {
      throw new Error(
        `control reader first line was not the healthy frame: ${first.value}`,
      );
    }
    expect(parsed.marker).toBe("healthy-frame");

    const code = await handle.exited;
    expect(code).toBe(0);
  });
});
