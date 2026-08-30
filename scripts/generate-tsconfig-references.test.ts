// Drives the generator through its real command line against a throwaway
// fixture workspace, the same way run-all.test.ts exercises run-all.ts. This
// script is the only thing standing between package.json's real dependency
// graph and every package's `references` array — a silently wrong graph
// would make `tsc --build` skip stale dependents or, worse, refuse the whole
// build over a phantom cycle.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const GENERATOR = join(import.meta.dir, "generate-tsconfig-references.ts");

let workspace = "";

async function writePackage(
  name: string,
  dependencies: Record<string, string> = {},
  options: { withTest?: boolean; srcFile?: string } = {},
): Promise<void> {
  const dir = join(workspace, "packages", name);
  await mkdir(join(dir, "src"), { recursive: true });
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({ name: `@fixture/${name}`, dependencies }, null, 2),
  );
  await writeFile(
    join(dir, "tsconfig.json"),
    JSON.stringify({ extends: "../../tsconfig.base.json" }, null, 2),
  );
  await writeFile(
    join(dir, "src", "index.ts"),
    options.srcFile ?? "export const value = 1;\n",
  );
  if (options.withTest) {
    await mkdir(join(dir, "test"), { recursive: true });
    await writeFile(join(dir, "test", "index.test.ts"), "export {};\n");
  }
}

async function readTsconfig(name: string, file = "tsconfig.json") {
  const path = join(workspace, "packages", name, file);
  return JSON.parse(await Bun.file(path).text()) as {
    compilerOptions?: Record<string, unknown>;
    references?: { path: string }[];
    include?: string[];
  };
}

async function tsconfigExists(name: string, file: string): Promise<boolean> {
  return Bun.file(join(workspace, "packages", name, file)).exists();
}

function run(args: string[]): Promise<{ exitCode: number; stderr: string }> {
  return (async () => {
    const child = Bun.spawn(["bun", "run", GENERATOR, ...args], {
      cwd: workspace,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stderr, exitCode] = await Promise.all([
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { exitCode, stderr };
  })();
}

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "workbench-tsconfig-refs-"));
  for (const root of ["apps", "packages", "tools", "workflows"]) {
    await mkdir(join(workspace, root), { recursive: true });
  }
  await mkdir(join(workspace, "vendor", "intx"), { recursive: true });
});

afterEach(async () => {
  if (workspace !== "") await rm(workspace, { recursive: true, force: true });
});

describe("generate-tsconfig-references", () => {
  test("gives a leaf package composite settings and no references", async () => {
    await writePackage("leaf");
    await run([]);

    const config = await readTsconfig("leaf");
    expect(config.compilerOptions?.["composite"]).toBe(true);
    expect(config.compilerOptions?.["outDir"]).toBe("dist");
    expect(config.references ?? []).toEqual([]);
  });

  test("references a real workspace dependency by relative path", async () => {
    await writePackage("leaf");
    await writePackage("consumer", { "@fixture/leaf": "workspace:*" });
    await run([]);

    const config = await readTsconfig("consumer");
    expect(config.references).toEqual([{ path: "../leaf" }]);
  });

  test("does not reference a devDependency", async () => {
    await writePackage("leaf");
    const dir = join(workspace, "packages", "consumer");
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify(
        {
          name: "@fixture/consumer",
          devDependencies: { "@fixture/leaf": "workspace:*" },
        },
        null,
        2,
      ),
    );
    await writeFile(
      join(dir, "tsconfig.json"),
      JSON.stringify({ extends: "../../tsconfig.base.json" }, null, 2),
    );
    await writeFile(join(dir, "src", "index.ts"), "export {};\n");
    await run([]);

    const config = await readTsconfig("consumer");
    expect(config.references ?? []).toEqual([]);
  });

  test("writes a sibling tsconfig.test.json that references the same deps", async () => {
    await writePackage("leaf");
    await writePackage(
      "consumer",
      { "@fixture/leaf": "workspace:*" },
      { withTest: true },
    );
    await run([]);

    const testConfig = await readTsconfig("consumer", "tsconfig.test.json");
    expect(testConfig.references).toEqual([{ path: "../leaf" }]);
    expect(testConfig.compilerOptions?.["composite"]).toBe(false);
    expect(testConfig.include).toContain("test");
  });

  test("gives tsconfig.test.json an explicit rootDir at the workspace root", async () => {
    // Without this, TypeScript infers `rootDir` from `include` alone once
    // `outDir` is inherited from the extended src config, and TS6059s on
    // any file a test reaches outside "src"/"test" -- which a shared test
    // helper living outside every package's own directory always is.
    await writePackage("leaf", {}, { withTest: true });
    await run([]);

    const testConfig = await readTsconfig("leaf", "tsconfig.test.json");
    expect(testConfig.compilerOptions?.["rootDir"]).toBe("../..");
  });

  test("excludes a real dependency cycle from the composite graph entirely", async () => {
    await writePackage("cycle-a", { "@fixture/cycle-b": "workspace:*" });
    await writePackage("cycle-b", { "@fixture/cycle-a": "workspace:*" });
    await run([]);

    const a = await readTsconfig("cycle-a");
    expect(a.compilerOptions?.["composite"]).toBeUndefined();
    expect(a.references ?? []).toEqual([]);
    expect(await tsconfigExists("cycle-a", "tsconfig.test.json")).toBe(false);
  });

  // A package that is not itself part of a dependency cycle, but depends on
  // one that is, must also be excluded from the composite graph.
  // Half-excluding just the cycle members leaves their consumers pulling the
  // excluded dependency's raw source directly into their own composite
  // program, which TypeScript flags as a rootDir violation (TS6059) once it
  // walks further into that source's own imports.
  test("excludes a transitive (non-cyclic) consumer of a cyclic package", async () => {
    await writePackage("cycle-a", { "@fixture/cycle-b": "workspace:*" });
    await writePackage("cycle-b", { "@fixture/cycle-a": "workspace:*" });
    await writePackage("consumer", { "@fixture/cycle-a": "workspace:*" });
    await run([]);

    const consumer = await readTsconfig("consumer");
    expect(consumer.compilerOptions?.["composite"]).toBeUndefined();
    expect(consumer.references ?? []).toEqual([]);
    expect(await tsconfigExists("consumer", "tsconfig.test.json")).toBe(false);
  });

  test("excludes a two-hop transitive consumer of a cyclic package", async () => {
    await writePackage("cycle-a", { "@fixture/cycle-b": "workspace:*" });
    await writePackage("cycle-b", { "@fixture/cycle-a": "workspace:*" });
    await writePackage("mid", { "@fixture/cycle-a": "workspace:*" });
    await writePackage("outer", { "@fixture/mid": "workspace:*" });
    await run([]);

    const outer = await readTsconfig("outer");
    expect(outer.compilerOptions?.["composite"]).toBeUndefined();
    expect(outer.references ?? []).toEqual([]);
  });

  test("does not exclude an unrelated package outside the cycle's dependents", async () => {
    await writePackage("cycle-a", { "@fixture/cycle-b": "workspace:*" });
    await writePackage("cycle-b", { "@fixture/cycle-a": "workspace:*" });
    await writePackage("unrelated");
    await run([]);

    const unrelated = await readTsconfig("unrelated");
    expect(unrelated.compilerOptions?.["composite"]).toBe(true);
  });

  test("excludes a package whose src imports a shared root script", async () => {
    await writePackage(
      "uses-harness",
      {},
      {
        srcFile: 'import { harness } from "../../../scripts/e2e/harness.ts";\n',
      },
    );
    await run([]);

    const config = await readTsconfig("uses-harness");
    expect(config.compilerOptions?.["composite"]).toBeUndefined();
  });

  test("--check reports drift without writing", async () => {
    await writePackage("leaf");
    const before = await readTsconfig("leaf");

    const result = await run(["--check"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("tsconfig.json");
    expect(await readTsconfig("leaf")).toEqual(before);
  });

  test("--check passes once the tree is in sync", async () => {
    await writePackage("leaf");
    await writePackage("consumer", { "@fixture/leaf": "workspace:*" });
    await run([]);

    const result = await run(["--check"]);

    expect(result.exitCode).toBe(0);
  });
});
