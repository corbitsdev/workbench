// Restructured from the private repo faremeter/interchange-e2b-provisioner
// (github.com/faremeter/interchange-e2b-provisioner) at commit c1e3182. We
// now own this code; it is not a vendored path.

import { isAbsolute } from "node:path";

import { type } from "arktype";

const Environment = type({
  E2B_API_KEY: "string > 0",
  E2B_TEMPLATE: "string > 0",
  "E2B_SANDBOX_TIMEOUT_MS?": "string",
});

export type ProvisionerConfig = {
  readonly apiKey: string;
  readonly template: string;
  readonly dataDir: string;
  readonly sandboxTimeoutMs: number;
  readonly requestTimeoutMs: number;
};

/**
 * `dataDir` is the HUB's own state directory for this backend -- where the
 * allocation fences, destroy tombstones, and sandbox refs live -- not the
 * sandbox's `SIDECAR_DATA_DIR`. The hub derives it from its data dir the
 * same way it does for the container backend, so it is a caller argument
 * rather than an environment variable an operator could point somewhere
 * unrelated.
 */
export function readProvisionerConfig(
  env: Record<string, string | undefined>,
  dataDir: string,
): ProvisionerConfig {
  const parsed = Environment(env);
  if (parsed instanceof type.errors) {
    throw new Error(`Invalid E2B provisioner configuration: ${parsed.summary}`);
  }
  if (!parsed.E2B_API_KEY.startsWith("e2b_") || parsed.E2B_API_KEY.length < 16) {
    throw new Error("E2B_API_KEY must be a valid E2B API key");
  }
  if (!isAbsolute(dataDir)) {
    throw new Error("E2B provisioner data dir must be an absolute path");
  }

  const sandboxTimeoutMs = readTimeout(
    parsed.E2B_SANDBOX_TIMEOUT_MS,
    15 * 60 * 1_000,
  );
  return {
    apiKey: parsed.E2B_API_KEY,
    template: parsed.E2B_TEMPLATE,
    dataDir,
    sandboxTimeoutMs,
    requestTimeoutMs: 60_000,
  };
}
function readTimeout(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const timeoutMs = Number(value);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 60_000) {
    throw new Error("E2B_SANDBOX_TIMEOUT_MS must be at least 60000");
  }
  if (timeoutMs > 24 * 60 * 60 * 1_000) {
    throw new Error("E2B_SANDBOX_TIMEOUT_MS cannot exceed 24 hours");
  }
  return timeoutMs;
}
