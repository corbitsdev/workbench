// happy-dom does not apply stylesheets, so the avatar identity palette is
// locked against CSS source: :root must define exactly the four --avatar-N
// tokens with their pinned hex values (the proposed upstream contract).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const css = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../src/styles.css"),
  "utf8",
);

function rootBodies(): string[] {
  return [
    ...css.matchAll(/(?:^|\n)\s*:root\s*\{([^}]+)\}/g),
  ].map((match) => match[1] ?? "");
}

describe("avatar token contract", () => {
  test(":root defines exactly the four avatar pastels with pinned hex", () => {
    const bodies = rootBodies();
    expect(bodies.length).toBeGreaterThan(0);
    const body = bodies[0] ?? "";

    expect(body).toMatch(/--avatar-1:\s*#c5d2de\s*;/);
    expect(body).toMatch(/--avatar-2:\s*#c1d1be\s*;/);
    expect(body).toMatch(/--avatar-3:\s*#f7ead5\s*;/);
    expect(body).toMatch(/--avatar-4:\s*#f2b277\s*;/);

    const tokens = [...body.matchAll(/--avatar-(\d+)\s*:/g)].map(
      (match) => match[1],
    );
    expect(tokens.sort()).toEqual(["1", "2", "3", "4"]);
  });
});
