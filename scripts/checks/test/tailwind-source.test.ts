import { expect, test } from "bun:test";
import {
  auditTailwindSource,
  importedStylesheetPackages,
  sourcedPackages,
} from "../tailwind-source";

test("importedStylesheetPackages reads @corbits/*/styles.css imports only", () => {
  const css = [
    '@import "@corbits/chat-ui/styles.css";',
    '@import "@corbits/plugins-ui/styles.css";',
    "html { font-size: 15px; }",
  ].join("\n");
  expect(importedStylesheetPackages(css)).toEqual(["chat-ui", "plugins-ui"]);
});

test("sourcedPackages reads @source packages/<name>/src entries only", () => {
  const css = [
    '@source "../../../packages/bench-ui/src";',
    '@source "../../../packages/chat-ui/src";',
  ].join("\n");
  expect(sourcedPackages(css)).toEqual(["bench-ui", "chat-ui"]);
});

test("a stylesheet import with no matching @source entry is a violation", () => {
  const report = auditTailwindSource(["chat-ui", "plugins-ui"], ["chat-ui"]);
  expect(report.violations).toHaveLength(1);
  expect(report.violations[0]).toContain("plugins-ui");
  expect(report.violations[0]).toContain("tailwind.css");
  expect(report.violations[0]).toContain("silently");
});

test("every import matched by a @source entry passes", () => {
  const report = auditTailwindSource(
    ["chat-ui", "plugins-ui"],
    ["chat-ui", "plugins-ui"],
  );
  expect(report.violations).toEqual([]);
});

test("a @source entry with no matching import is not a violation", () => {
  const report = auditTailwindSource(["chat-ui"], ["artifact-ui", "chat-ui"]);
  expect(report.violations).toEqual([]);
});
