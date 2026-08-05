// End-to-end boot check: the host process starts against a stub hub,
// dials in over WebSocket, and exits cleanly on SIGTERM. The stub is a
// bare WebSocket acceptor -- the host's first register frame proves the
// dial-in reached the application layer, not just the socket.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";

const APP_ROOT = path.join(import.meta.dir, "..");

function requireTestPath(): string {
  const value = process.env["PATH"];
  if (value === undefined) {
    throw new Error("PATH missing from the test environment");
  }
  return value;
}

test("host dials in against a stub hub and exits cleanly on SIGTERM", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "sidecar-boot-"));
  const registered = Promise.withResolvers<string>();
  const server = Bun.serve({
    port: 0,
    fetch(request, srv) {
      if (srv.upgrade(request)) return undefined;
      return new Response("expected a websocket upgrade", { status: 400 });
    },
    websocket: {
      open() {},
      message(_ws, message) {
        registered.resolve(
          typeof message === "string" ? message : message.toString(),
        );
      },
    },
  });
  try {
    const proc = Bun.spawn(["bun", "src/index.ts"], {
      cwd: APP_ROOT,
      env: {
        PATH: requireTestPath(),
        SIDECAR_DATA_DIR: dataDir,
        HUB_WS_URL: `ws://localhost:${String(server.port)}/api/sidecars/ws`,
        SIDECAR_ID: "sidecar-under-test",
        SIDECAR_TOKEN: "token-under-test",
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    const firstFrame = await registered.promise;
    expect(firstFrame).toContain("register");

    proc.kill("SIGTERM");
    const exitCode = await proc.exited;
    expect(exitCode).toBe(0);
  } finally {
    server.stop(true);
    await rm(dataDir, { recursive: true, force: true });
  }
}, 20_000);

test("host refuses to boot when the environment is incomplete, naming the variable", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "sidecar-boot-"));
  try {
    const proc = Bun.spawn(["bun", "src/index.ts"], {
      cwd: APP_ROOT,
      env: {
        PATH: requireTestPath(),
        SIDECAR_DATA_DIR: dataDir,
        HUB_WS_URL: "ws://localhost:9/api/sidecars/ws",
        SIDECAR_ID: "sidecar-under-test",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    const stderr = await new Response(proc.stderr).text();
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("SIDECAR_TOKEN");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}, 20_000);
