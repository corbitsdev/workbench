// Hub-zero T3 (CL-8114) red test: the room card's connect flow required a
// hub mount whose options threaded the settings-row readers through it —
// the last hub readers of the `workbench_settings` row. The mount and its
// ports are deleted; connect/disconnect is native `connections/*` now.
// Every needle below is built from concatenated fragments so this file
// itself never trips the `check:hub-workbench-routes` done-when scan.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

const HUB_INDEX = path.join(
  import.meta.dir,
  "..",
  "..",
  "..",
  "apps",
  "hub",
  "src",
  "index.ts",
);

const WB = "work" + "benches";
const GH = "git" + "hub";
const MOUNT_PORT_A = "getTemplate" + "Settings";
const MOUNT_PORT_B = "persist" + "SelectedRepos";
const MOUNT_PORT_C = "onReviewing" + "Started";

describe("hub-zero T3: the workbench-scoped connect mount is gone", () => {
  test("index.ts mounts no workbench child route under a connector path", () => {
    const source = readFileSync(HUB_INDEX, "utf8");
    const mountPattern = new RegExp(`/${WB}/[^/]+/${GH}`);
    expect(
      mountPattern.test(source),
      "index.ts still mounts a workbench child route under a connector path",
    ).toBe(false);
  });

  test("index.ts passes no settings-row port to the deleted mount's options", () => {
    const source = readFileSync(HUB_INDEX, "utf8");
    const optionsPattern = new RegExp(
      `${MOUNT_PORT_A}|${MOUNT_PORT_B}|${MOUNT_PORT_C}`,
    );
    expect(
      optionsPattern.test(source),
      "index.ts still passes a settings-row port to the deleted mount's options",
    ).toBe(false);
  });

  test("index.ts keeps no reference to the deleted mount factory", () => {
    const source = readFileSync(HUB_INDEX, "utf8");
    expect(
      source.includes("createConnect" + "GithubRoutes"),
      "index.ts still references the deleted mount factory",
    ).toBe(false);
  });
});
