// happy-dom does not apply stylesheets, so paint/chrome for `.chat-bubble`
// is locked against CSS source (CL-6466: leftover bubble class, no chrome).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const css = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../src/styles.css"),
  "utf8",
);

function ruleBodies(selector: string): string[] {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [
    ...css.matchAll(
      new RegExp(`(?:^|\\n)\\s*${escaped}\\s*\\{([^}]+)\\}`, "g"),
    ),
  ].map((match) => match[1] ?? "");
}

describe("chat-bubble is visually flat", () => {
  test(".chat-bubble has no border, fill, padding, or radius", () => {
    const bodies = ruleBodies(".chat-bubble");
    expect(bodies.length).toBeGreaterThan(0);
    const body = bodies[0] ?? "";
    expect(body).toMatch(/border:\s*0/);
    expect(body).toMatch(/background:\s*transparent/);
    expect(body).toMatch(/padding:\s*0/);
    expect(body).toMatch(/border-radius:\s*0/);
  });

  test('.chat-bubble[data-own="true"] does not paint chrome', () => {
    for (const body of ruleBodies('.chat-bubble[data-own="true"]')) {
      expect(body).not.toMatch(/background\s*:/);
      expect(body).not.toMatch(/border\s*:/);
      expect(body).not.toMatch(/padding\s*:/);
      expect(body).not.toMatch(/border-radius\s*:/);
      expect(body).not.toMatch(/box-shadow\s*:/);
    }
  });
});
