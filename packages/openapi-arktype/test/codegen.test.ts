import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { generate } from "../src/codegen/index.js";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtemp, mkdir, rm, readFile } from "node:fs/promises";

const thisDir = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(thisDir, "fixtures");
const projectRoot = dirname(thisDir);
const tmpBase = join(projectRoot, "tmp");

let outDir: string;

beforeEach(async () => {
  await mkdir(tmpBase, { recursive: true });
  outDir = await mkdtemp(join(tmpBase, "codegen-test-"));
});

afterEach(async () => {
  await rm(outDir, { recursive: true, force: true });
});

describe("generate", () => {
  it("generates schemas.ts, operations.ts, and index.ts", async () => {
    const result = await generate({
      path: join(fixturesDir, "petstore-3.1.json"),
      outDir,
    });

    expect(result.files).toHaveLength(3);
    expect(result.files.some((f) => f.endsWith("schemas.ts"))).toBe(true);
    expect(result.files.some((f) => f.endsWith("operations.ts"))).toBe(true);
    expect(result.files.some((f) => f.endsWith("index.ts"))).toBe(true);
  });

  it("generates valid schemas.ts content", async () => {
    await generate({
      path: join(fixturesDir, "petstore-3.1.json"),
      outDir,
    });

    const content = await readFile(join(outDir, "schemas.ts"), "utf-8");

    // Should import from arktype
    expect(content).toContain('import { type } from "arktype"');

    // Should have named exports for each schema
    expect(content).toContain("export const Pet");
    expect(content).toContain("export const NewPet");
    expect(content).toContain("export const Error");
    expect(content).toContain("export const Status");

    // Pet should have properties
    expect(content).toContain('"id"');
    expect(content).toContain('"name"');

    // Status should be an enum
    expect(content).toContain("type.enumerated");
    expect(content).toContain('"available"');
    expect(content).toContain('"pending"');
    expect(content).toContain('"sold"');
  });

  it("generates operations.ts with operation validators", async () => {
    await generate({
      path: join(fixturesDir, "petstore-3.1.json"),
      outDir,
    });

    const content = await readFile(join(outDir, "operations.ts"), "utf-8");

    expect(content).toContain('import { type } from "arktype"');
    expect(content).toContain("export const listPets");
    expect(content).toContain("export const createPet");
    expect(content).toContain("export const showPetById");

    // listPets should have queryParams and responses
    expect(content).toContain("queryParams");
    expect(content).toContain("responses");
  });

  it("generates index.ts that re-exports", async () => {
    await generate({
      path: join(fixturesDir, "petstore-3.1.json"),
      outDir,
    });

    const content = await readFile(join(outDir, "index.ts"), "utf-8");

    expect(content).toContain('export * from "./schemas.js"');
    expect(content).toContain('export * from "./operations.js"');
  });

  it("uses string DSL for simple types", async () => {
    await generate({
      path: join(fixturesDir, "petstore-3.1.json"),
      outDir,
    });

    const content = await readFile(join(outDir, "schemas.ts"), "utf-8");

    // Should use arktype string DSL for primitive types
    expect(content).toContain('"number.integer"');
    expect(content).toContain('"string"');
  });

  it("emits format as arktype keyword", async () => {
    await generate({
      path: join(fixturesDir, "petstore-3.1.json"),
      outDir,
    });

    const content = await readFile(join(outDir, "schemas.ts"), "utf-8");

    // Pet has email field with format: email
    expect(content).toContain('"string.email"');
  });

  it("handles string constraints in DSL", async () => {
    await generate({
      path: join(fixturesDir, "petstore-3.1.json"),
      outDir,
    });

    const content = await readFile(join(outDir, "schemas.ts"), "utf-8");

    // Pet.name has minLength: 1
    expect(content).toContain('"string>=1"');
  });
});
