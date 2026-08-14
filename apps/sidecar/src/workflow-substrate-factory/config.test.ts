import { expect, test } from "bun:test";

import { deriveHubHttpUrl } from "./config";

test("derives an https origin from a wss:// hub URL", () => {
  expect(deriveHubHttpUrl("wss://hub.example.com/api/sidecars/ws")).toBe(
    "https://hub.example.com",
  );
});

test("derives an http origin from a ws:// hub URL", () => {
  expect(deriveHubHttpUrl("ws://localhost:3000/api/sidecars/ws")).toBe(
    "http://localhost:3000",
  );
});

test("preserves a non-default port", () => {
  expect(deriveHubHttpUrl("wss://hub.example.com:8443/ws")).toBe(
    "https://hub.example.com:8443",
  );
});
