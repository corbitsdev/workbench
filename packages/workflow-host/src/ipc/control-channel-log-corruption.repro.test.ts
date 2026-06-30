// CL-2585 regression. The workflow-child's supervisor control channel used to
// BE its stdin/stdout. `@intx/log`/LogTape route INFO/DEBUG to
// console.info/console.debug -> stdout, the same fd the upstream control
// channel wrote to, so a single log line interleaved into the NDJSON control
// stream and crashed the supervisor's control reader ("control channel received
// non-JSON line") -> onChildCrash -> reason=corrupt.
//
// The fix moves the control channel onto dedicated inherited fds (4 down, 5 up)
// so stdin/stdout/stderr are free for the child's logs. This test pins the
// child-side binding: the real `defaultControlWriter`/`defaultControlReader`
// must read/write the dedicated control fds, NOT stdin/stdout. It spawns a real
// child that drives those defaults and asserts the upstream frame surfaces on
// fd 5 while a stray stdout log line stays out of the control stream.
//
// Red on the pre-fix transport (defaults bound to stdin/stdout): the upstream
// frame lands on stdout (fd 1), so the parent reading fd 5 sees nothing and the
// test times out / yields no frame. Green after the FD change.

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { CONTROL_DOWN_FD, CONTROL_UP_FD } from "../index";

let tmpRoot: string;

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "intx-ctl-fd-test-"));
});

afterAll(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe("CL-2585 control channel FD isolation", () => {
  test("CONTROL_DOWN_FD/CONTROL_UP_FD are the dedicated fds 4/5, distinct from stdio", () => {
    // These constants pin the on-wire fd convention the supervisor's
    // Bun.spawn stdio indices must mirror. fd 0/1/2 stay free for
    // stdin/stdout/stderr; fd 3 is the event channel.
    expect(CONTROL_DOWN_FD).toBe(4);
    expect(CONTROL_UP_FD).toBe(5);
    expect(CONTROL_DOWN_FD).not.toBe(CONTROL_UP_FD);
  });

  test("defaultControlWriter writes the upstream frame to fd 5 (not stdout); a stray stdout log never enters the control stream", async () => {
    // The child uses the REAL defaultControlWriter()/defaultControlReader()
    // exported from the package, writes a stray ANSI log line to stdout,
    // then an upstream control frame via the default writer, then echoes
    // any downstream frame the parent sends on fd 4 back through the
    // default writer. The parent reads fd 5 and must see only JSON frames.
    const childScript = `
import { defaultControlWriter, defaultControlReader } from "${path.resolve(import.meta.dir, "../index.ts")}";
// stray ANSI log on stdout — must NOT reach the control reader
process.stdout.write("\\x1B[32mINF\\x1B[0m a stray log line\\n");
const writer = defaultControlWriter();
const reader = defaultControlReader();
await writer.write(JSON.stringify({ frame: "upstream", marker: "healthy" }) + "\\n");
// read one downstream frame off CONTROL_DOWN_FD and echo it back up
for await (const line of reader.read()) {
  const parsed = JSON.parse(line);
  await writer.write(JSON.stringify({ frame: "echo", got: parsed.ping }) + "\\n");
  break;
}
process.exit(0);
`;
    const scriptPath = path.join(tmpRoot, `child-${String(Date.now())}.ts`);
    await fs.writeFile(scriptPath, childScript, "utf-8");

    // Mirror the supervisor's spawn stdio convention: inherit 0/1/2,
    // pipe fd 3 (event, unused here), fd 4 (control-down), fd 5 (control-up).
    const proc = Bun.spawn([process.execPath, scriptPath], {
      stdio: ["inherit", "pipe", "inherit", "pipe", "pipe", "pipe"],
    });

    const controlDownFd = proc.stdio[CONTROL_DOWN_FD];
    const controlUpFd = proc.stdio[CONTROL_UP_FD];
    if (typeof controlDownFd !== "number" || typeof controlUpFd !== "number") {
      throw new Error("expected numeric control fds from Bun.spawn");
    }

    // Parent: send one downstream frame on fd 4.
    const downWriter = Bun.file(controlDownFd).writer();
    downWriter.write(JSON.stringify({ ping: "pong" }) + "\n");
    await downWriter.flush();

    // Parent: read the upstream control stream off fd 5 and collect frames.
    const upStream = Bun.file(controlUpFd).stream();
    const decoder = new TextDecoder();
    const reader = upStream.getReader();
    let pending = "";
    const lines: string[] = [];
    while (lines.length < 2) {
      const { value, done } = await reader.read();
      if (value) pending += decoder.decode(value, { stream: true });
      let nl = pending.indexOf("\n");
      while (nl >= 0) {
        const line = pending.slice(0, nl);
        pending = pending.slice(nl + 1);
        if (line.length > 0) lines.push(line);
        nl = pending.indexOf("\n");
      }
      if (done) break;
    }
    reader.releaseLock();

    // Every line on the control stream parses as JSON — the stray stdout
    // log line never entered it.
    const parsed = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(parsed[0]).toMatchObject({ frame: "upstream", marker: "healthy" });
    // The echo proves the downstream direction (fd 4) also works.
    expect(parsed[1]).toMatchObject({ frame: "echo", got: "pong" });

    await proc.exited;
  });
});
