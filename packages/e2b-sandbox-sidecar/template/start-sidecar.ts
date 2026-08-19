// Restructured from the private repo faremeter/interchange-e2b-provisioner
// (github.com/faremeter/interchange-e2b-provisioner) at commit c1e3182. We
// now own this code; it is not a vendored path.

import { mkdir } from "node:fs/promises";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    throw new Error(`${name} environment variable is required`);
  }
  return value;
}

const dataDir = requireEnv("SIDECAR_DATA_DIR");
await mkdir(dataDir, { recursive: true, mode: 0o700 });

const child = Bun.spawn(
  [process.execPath, "run", "/repo/apps/sidecar/src/index.ts"],
  {
    cwd: "/repo",
    env: process.env,
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  },
);

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => child.kill(signal));
}

process.exitCode = await child.exited;
