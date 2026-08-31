import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { createDisposableHubDataDir } from "./disposable-hub-data-dir";

test("points HUB_DATA_DIR at a fresh directory under the OS temp dir", () => {
  const previous = process.env["HUB_DATA_DIR"];
  const { hubDataDir, restore } = createDisposableHubDataDir();
  try {
    expect(hubDataDir.startsWith(tmpdir())).toBe(true);
    expect(existsSync(hubDataDir)).toBe(true);
    expect(process.env["HUB_DATA_DIR"]).toBe(hubDataDir);
  } finally {
    restore();
  }
  expect(existsSync(hubDataDir)).toBe(false);
  if (previous === undefined)
    expect(process.env["HUB_DATA_DIR"]).toBeUndefined();
  else expect(process.env["HUB_DATA_DIR"]).toBe(previous);
});

test("clears HUB_ALLOW_GIT_INSIDE_WORK_TREE so tests cannot inherit local-dev opt-in", () => {
  const previous = process.env["HUB_ALLOW_GIT_INSIDE_WORK_TREE"];
  process.env["HUB_ALLOW_GIT_INSIDE_WORK_TREE"] = "1";
  const { restore } = createDisposableHubDataDir();
  try {
    expect(process.env["HUB_ALLOW_GIT_INSIDE_WORK_TREE"]).toBeUndefined();
  } finally {
    restore();
  }
  expect(process.env["HUB_ALLOW_GIT_INSIDE_WORK_TREE"]).toBe("1");
  if (previous === undefined) {
    delete process.env["HUB_ALLOW_GIT_INSIDE_WORK_TREE"];
  } else {
    process.env["HUB_ALLOW_GIT_INSIDE_WORK_TREE"] = previous;
  }
});
