import { expect, test } from "bun:test";
import { auditReactUiPins, type PinnedManifest } from "../react-ui-pin";

test("one shared pin across every consumer passes, and the note names it", () => {
  const manifests: PinnedManifest[] = [
    {
      relPath: "packages/chat-ui/package.json",
      pin: "github:corbitsdev/react-ui#aaaa111",
    },
    {
      relPath: "apps/web/package.json",
      pin: "github:corbitsdev/react-ui#aaaa111",
    },
  ];
  const report = auditReactUiPins(manifests);
  expect(report.violations).toEqual([]);
  expect(report.notes.some((note) => note.includes("aaaa111"))).toBe(true);
});

test("two pins is a violation that names every offending manifest and pin", () => {
  const manifests: PinnedManifest[] = [
    {
      relPath: "packages/chat-ui/package.json",
      pin: "github:corbitsdev/react-ui#aaaa111",
    },
    {
      relPath: "packages/tasks-ui/package.json",
      pin: "github:corbitsdev/react-ui#bbbb222",
    },
    {
      relPath: "apps/web/package.json",
      pin: "github:corbitsdev/react-ui#aaaa111",
    },
  ];
  const report = auditReactUiPins(manifests);
  expect(report.violations.length).toBeGreaterThan(0);
  const all = report.violations.join("\n");
  expect(all).toContain("packages/chat-ui/package.json");
  expect(all).toContain("packages/tasks-ui/package.json");
  expect(all).toContain("apps/web/package.json");
  expect(all).toContain("aaaa111");
  expect(all).toContain("bbbb222");
});

test("a repo with no react-ui consumer at all is not a failure", () => {
  expect(auditReactUiPins([]).violations).toEqual([]);
});

// The whole point is catching the version that differs, so a pin that
// merely *looks* different (ref shorthand, ssh vs https) must not read as
// agreement — compare the pin verbatim.
test("the same commit reached by a different specifier still counts as drift", () => {
  const manifests: PinnedManifest[] = [
    { relPath: "a/package.json", pin: "github:corbitsdev/react-ui#aaaa111" },
    {
      relPath: "b/package.json",
      pin: "git+ssh://git@github.com/corbitsdev/react-ui#aaaa111",
    },
  ];
  expect(auditReactUiPins(manifests).violations.length).toBeGreaterThan(0);
});
