// Shared by tool-materialization.ts and workflow-closure-materialization.ts
// so both loader-boundary inputs (registry map, host platform) come from
// one source of truth rather than duplicated env parsing and allowlists.

import { type } from "arktype";
import type { HostPlatform, RegistryConfig } from "@intx/tool-packaging";

// name rides alongside the config so an operator authors a flat JSON array;
// this collapses it into a Map keyed by name for the loader.
const RegistryConfigEnvEntry = type({
  name: "string",
  url: "string",
  "auth?": type({
    "token?": "string",
    "basic?": type({ user: "string", pass: "string" }),
  }),
});
const RegistryConfigEnvArray = RegistryConfigEnvEntry.array();

export function readRegistries(): ReadonlyMap<string, RegistryConfig> {
  const raw = process.env["SIDECAR_TOOL_REGISTRIES"];
  if (raw === undefined) {
    return new Map([["npmjs", { url: "https://registry.npmjs.org" }]]);
  }
  // An empty string almost always means misconfig; falling through to the
  // npmjs default would silently route packages through public npm.
  if (raw.trim() === "") {
    throw new Error(
      "SIDECAR_TOOL_REGISTRIES is set but empty — unset the variable to use the default npmjs registry",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `SIDECAR_TOOL_REGISTRIES is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const validated = RegistryConfigEnvArray(parsed);
  if (validated instanceof type.errors) {
    throw new Error(`SIDECAR_TOOL_REGISTRIES failed validation: ${validated.summary}`);
  }
  const out = new Map<string, RegistryConfig>();
  for (const entry of validated) {
    if (out.has(entry.name)) {
      throw new Error(
        `SIDECAR_TOOL_REGISTRIES has duplicate registry name ${JSON.stringify(entry.name)}`,
      );
    }
    const config: RegistryConfig = {
      url: entry.url,
      ...(entry.auth !== undefined ? { auth: entry.auth } : {}),
    };
    out.set(entry.name, config);
  }
  return out;
}

// Validated at the boundary so an unknown process.platform token fails
// boot instead of silently mis-routing the loader's os filter. A Node/Bun
// major bump adding a new platform value will fail boot until refreshed.
const KNOWN_PROCESS_PLATFORMS = new Set<NodeJS.Platform>([
  "aix",
  "android",
  "darwin",
  "freebsd",
  "haiku",
  "linux",
  "openbsd",
  "sunos",
  "win32",
  "cygwin",
  "netbsd",
]);

// Same rationale as KNOWN_PROCESS_PLATFORMS, for process.arch.
const KNOWN_PROCESS_ARCHS = new Set<NodeJS.Architecture>([
  "arm",
  "arm64",
  "ia32",
  "loong64",
  "mips",
  "mipsel",
  "ppc64",
  "riscv64",
  "s390x",
  "x64",
]);

function assertKnownHostPlatform(platform: NodeJS.Platform): void {
  if (!KNOWN_PROCESS_PLATFORMS.has(platform)) {
    throw new Error(
      `sidecar boot: process.platform ${JSON.stringify(platform)} is not a recognized npm \`os\` token; tool-package platform filtering would be unreliable`,
    );
  }
}

function assertKnownHostArch(arch: NodeJS.Architecture): void {
  if (!KNOWN_PROCESS_ARCHS.has(arch)) {
    throw new Error(
      `sidecar boot: process.arch ${JSON.stringify(arch)} is not a recognized npm \`cpu\` token; tool-package platform filtering would be unreliable`,
    );
  }
}

/** Both consumers resolve the host through this one helper so the allowlists and gate live in one place. */
export function resolveHostPlatform(): HostPlatform {
  assertKnownHostPlatform(process.platform);
  assertKnownHostArch(process.arch);
  return { os: process.platform, cpu: process.arch };
}
