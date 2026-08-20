// The nine `@corbits/*-tools` packages used to pack serially inside
// `publishCorbitsToolsRegistry`. This suite pins the helper that replaced
// that loop: independent work overlaps, a matching content hash can skip,
// and a changed package still rematerializes.
import { describe, expect, test } from "bun:test";
import { sha512Integrity } from "./publish";
import { materializePackages } from "./materialize";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("materializePackages", () => {
  test("runs independent materializes concurrently", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const release = Promise.withResolvers<void>();
    let arrived = 0;

    const pending = materializePackages({
      packageDirs: ["a", "b", "c"],
      concurrency: 3,
      materialize: async (packageDir) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        arrived += 1;
        if (arrived === 3) release.resolve();
        await release.promise;
        await delay(1);
        inFlight -= 1;
        return packageDir.toUpperCase();
      },
    });

    const results = await pending;
    expect(maxInFlight).toBe(3);
    expect(results).toEqual([
      { packageDir: "a", status: "ok", value: "A" },
      { packageDir: "b", status: "ok", value: "B" },
      { packageDir: "c", status: "ok", value: "C" },
    ]);
  });

  test("caps the worker pool at the requested concurrency", async () => {
    let inFlight = 0;
    let maxInFlight = 0;

    await materializePackages({
      packageDirs: ["a", "b", "c", "d"],
      concurrency: 2,
      materialize: async (packageDir) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await delay(15);
        inFlight -= 1;
        return packageDir;
      },
    });

    expect(maxInFlight).toBe(2);
  });

  test("skips a package whose content hash already matches the on-disk materialize", async () => {
    const encoder = new TextEncoder();
    const onDisk = new Map([
      ["unchanged", sha512Integrity(encoder.encode("same-bytes"))],
    ]);
    const current = new Map([
      ["unchanged", sha512Integrity(encoder.encode("same-bytes"))],
      ["changed", sha512Integrity(encoder.encode("new-bytes"))],
    ]);
    const materialized: string[] = [];

    const results = await materializePackages({
      packageDirs: ["unchanged", "changed"],
      materialize: async (packageDir) => {
        materialized.push(packageDir);
        return packageDir;
      },
      shouldSkip: (packageDir) => {
        const existing = onDisk.get(packageDir);
        const next = current.get(packageDir);
        return (
          existing !== undefined && next !== undefined && existing === next
        );
      },
    });

    expect(materialized).toEqual(["changed"]);
    expect(results).toEqual([
      { packageDir: "unchanged", status: "skipped" },
      { packageDir: "changed", status: "ok", value: "changed" },
    ]);
  });

  test("a changed package still rematerializes when hashes differ", async () => {
    const encoder = new TextEncoder();
    const existing = sha512Integrity(encoder.encode("old"));
    const next = sha512Integrity(encoder.encode("new"));
    expect(existing).not.toBe(next);

    const results = await materializePackages({
      packageDirs: ["pkg"],
      materialize: async () => "rematerialized",
      shouldSkip: () => existing === next,
    });

    expect(results).toEqual([
      { packageDir: "pkg", status: "ok", value: "rematerialized" },
    ]);
  });

  test("rejects when one materialize fails and does not swallow siblings", async () => {
    const seen: string[] = [];
    const pending = materializePackages({
      packageDirs: ["ok", "boom"],
      concurrency: 2,
      materialize: async (packageDir) => {
        seen.push(packageDir);
        if (packageDir === "boom") throw new Error("pack failed");
        return packageDir;
      },
    });
    await expect(pending).rejects.toThrow("pack failed");
    expect(seen.sort()).toEqual(["boom", "ok"]);
  });

  test("returns an empty list for no packages", async () => {
    const results = await materializePackages({
      packageDirs: [],
      materialize: async () => {
        throw new Error("should not materialize");
      },
    });
    expect(results).toEqual([]);
  });
});
