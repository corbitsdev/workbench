/// <reference types="bun" />
import { describe, expect, it } from "bun:test";

const indexHtml = await Bun.file(
  new URL("../index.html", import.meta.url),
).text();

describe("app metadata", () => {
  it("uses the Corbits browser title and favicon", () => {
    expect(indexHtml).toContain("<title>Workbench | Corbits</title>");
    expect(indexHtml).toContain(
      '<link rel="icon" type="image/svg+xml" href="/corbits-favicon-mono.svg" />',
    );
  });
});
