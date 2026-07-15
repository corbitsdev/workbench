import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("ui.tsx browser-safety", () => {
  it("does not value-import the server-only ./index module", () => {
    const src = readFileSync(join(import.meta.dir, "ui.tsx"), "utf8");
    expect(src).not.toMatch(/import\s+\{[^}]*\}\s+from\s+["']\.\/index["']/);
    expect(src).toMatch(/from\s+["']\.\/display-steps["']/);
  });
});