import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "bun:test";
import { writeFileAtomicDurable } from "../src/atomic-write";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function makeDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "sidecar-atomic-"));
  tempDirs.push(dir);
  return dir;
}

test("writes the contents and applies the mode", async () => {
  const dir = await makeDir();
  const target = path.join(dir, "record.json");
  await writeFileAtomicDurable(target, "{}", { mode: 0o600 });
  expect(await readFile(target, "utf8")).toBe("{}");
  const info = await stat(target);
  expect(info.mode & 0o777).toBe(0o600);
});

test("replaces an existing file completely", async () => {
  const dir = await makeDir();
  const target = path.join(dir, "record.json");
  await writeFileAtomicDurable(target, "first", { mode: 0o600 });
  await writeFileAtomicDurable(target, "second", { mode: 0o600 });
  expect(await readFile(target, "utf8")).toBe("second");
});

test("leaves no temp files behind after a write", async () => {
  const dir = await makeDir();
  await writeFileAtomicDurable(path.join(dir, "record.json"), "{}", {
    mode: 0o600,
  });
  expect(await readdir(dir)).toEqual(["record.json"]);
});
