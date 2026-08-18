import { expect, test } from "bun:test";
import { readSidecarConfig } from "../src/config";

const VALID_ENV = {
  SIDECAR_DATA_DIR: "/var/lib/sidecar",
  HUB_WS_URL: "wss://hub.example.com/api/sidecars/ws",
  SIDECAR_ID: "sidecar-1",
  SIDECAR_TOKEN: "secret-token",
  PATH: "/usr/local/bin:/usr/bin",
};

test("parses a complete environment into config", () => {
  const config = readSidecarConfig(VALID_ENV);
  expect(config).toEqual({
    dataDir: "/var/lib/sidecar",
    hubURL: "wss://hub.example.com/api/sidecars/ws",
    sidecarId: "sidecar-1",
    token: "secret-token",
    path: "/usr/local/bin:/usr/bin",
    home: undefined,
    tmpdir: undefined,
    toolRegistries: undefined,
    consumedRetentionMs: undefined,
    readyTimeoutMs: undefined,
  });
});

test("carries operator overrides for consumedRetentionMs/readyTimeoutMs through when present", () => {
  const config = readSidecarConfig({
    ...VALID_ENV,
    CONSUMED_RETENTION_MS: "3600000",
    CHILD_READY_TIMEOUT_MS: "5000",
  });
  expect(config.consumedRetentionMs).toBe(3_600_000);
  expect(config.readyTimeoutMs).toBe(5_000);
});

test("a non-numeric CONSUMED_RETENTION_MS fails boot naming the variable", () => {
  expect(() =>
    readSidecarConfig({ ...VALID_ENV, CONSUMED_RETENTION_MS: "not-a-number" }),
  ).toThrow(/CONSUMED_RETENTION_MS/);
});

test("a non-positive CHILD_READY_TIMEOUT_MS fails boot naming the variable", () => {
  expect(() =>
    readSidecarConfig({ ...VALID_ENV, CHILD_READY_TIMEOUT_MS: "0" }),
  ).toThrow(/CHILD_READY_TIMEOUT_MS/);
});

test("carries a valid tool-registry pin through as the raw JSON", () => {
  const pin = JSON.stringify([
    { name: "internal", url: "https://npm.example.com" },
  ]);
  const config = readSidecarConfig({
    ...VALID_ENV,
    SIDECAR_TOOL_REGISTRIES: pin,
  });
  expect(config.toolRegistries).toBe(pin);
});

test("a malformed tool-registry pin fails boot naming the variable", () => {
  expect(() =>
    readSidecarConfig({ ...VALID_ENV, SIDECAR_TOOL_REGISTRIES: "{not json" }),
  ).toThrow(/SIDECAR_TOOL_REGISTRIES/);
});

test("an empty tool-registry pin fails boot instead of defaulting to npmjs", () => {
  expect(() =>
    readSidecarConfig({ ...VALID_ENV, SIDECAR_TOOL_REGISTRIES: "" }),
  ).toThrow(/SIDECAR_TOOL_REGISTRIES/);
});

test("carries the optional child-env OS facts through when present", () => {
  const config = readSidecarConfig({
    ...VALID_ENV,
    HOME: "/home/sidecar",
    TMPDIR: "/var/tmp",
  });
  expect(config.home).toBe("/home/sidecar");
  expect(config.tmpdir).toBe("/var/tmp");
});

test("a missing PATH errors naming it", () => {
  const env: Record<string, string | undefined> = { ...VALID_ENV };
  delete env["PATH"];
  expect(() => readSidecarConfig(env)).toThrow(/PATH/);
});

test("ignores unrelated environment variables", () => {
  const config = readSidecarConfig({ ...VALID_ENV, UNRELATED: "value" });
  expect(config.sidecarId).toBe("sidecar-1");
});

test("a missing variable errors naming it", () => {
  const env: Record<string, string | undefined> = { ...VALID_ENV };
  delete env["SIDECAR_TOKEN"];
  expect(() => readSidecarConfig(env)).toThrow(/SIDECAR_TOKEN/);
});

test("an empty variable errors naming it", () => {
  expect(() => readSidecarConfig({ ...VALID_ENV, SIDECAR_ID: "" })).toThrow(
    /SIDECAR_ID/,
  );
});

test("a non-websocket hub URL errors naming the expected shape", () => {
  expect(() =>
    readSidecarConfig({ ...VALID_ENV, HUB_WS_URL: "https://hub.example.com" }),
  ).toThrow(/ws:\/\/ or wss:\/\//);
});

test("an unparseable hub URL errors", () => {
  expect(() =>
    readSidecarConfig({ ...VALID_ENV, HUB_WS_URL: "ws://" }),
  ).toThrow(/HUB_WS_URL/);
});
