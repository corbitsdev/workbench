import { expect, test } from "bun:test";
import { collectExportTargets, declaredDependencyNames } from "../lib/exports";
import { tarballNameFor } from "../packages";

test("tarballNameFor flattens a scoped name the way bun pm pack does", () => {
  expect(tarballNameFor("@workbench/echo", "0.0.1")).toBe(
    "workbench-echo-0.0.1.tgz",
  );
  expect(tarballNameFor("plain", "1.2.3")).toBe("plain-1.2.3.tgz");
});

test("collectExportTargets gathers every promised relative file once", () => {
  const targets = collectExportTargets({
    ".": { bun: "./src/index.ts", default: "./src/index.ts" },
    "./extra": "./src/extra.ts",
  });
  expect(targets.sort()).toEqual(["./src/extra.ts", "./src/index.ts"]);
});

test("declaredDependencyNames reads dependencies only", () => {
  expect(
    declaredDependencyNames({
      dependencies: { arktype: "catalog:" },
      devDependencies: { typescript: "catalog:" },
    }),
  ).toEqual(["arktype"]);
  expect(declaredDependencyNames({})).toEqual([]);
});
