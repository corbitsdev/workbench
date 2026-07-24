import { describe, expect, test } from "bun:test";
import { readdirSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

function repoRoot(): string {
  return join(import.meta.dir, "..", "..", "..");
}

// Every workspace member that has a package.json is recorded in the global
// bun.lock, and `bun install --frozen-lockfile` compares the on-disk member set
// against it. An image whose manifest-COPY block omits any member — even one it
// never imports — fails the install with "lockfile had changes".
function workspaceMemberManifests(): string[] {
  const members: string[] = [];
  for (const group of ["apps", "packages", "workflows"]) {
    const groupDir = join(repoRoot(), group);
    if (!existsSync(groupDir)) continue;
    for (const entry of readdirSync(groupDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const manifest = `${group}/${entry.name}/package.json`;
      if (existsSync(join(repoRoot(), manifest))) members.push(manifest);
    }
  }
  return members.sort();
}

const IMAGES = [
  "apps/hub/Dockerfile",
  "apps/sidecar/Dockerfile",
  "apps/web/Dockerfile",
];

describe("Dockerfile manifest COPY blocks cover every workspace member", () => {
  const members = workspaceMemberManifests();

  test("the repo has workspace members to check", () => {
    expect(members.length).toBeGreaterThan(0);
  });

  for (const image of IMAGES) {
    test(`${image} copies every workspace manifest before bun install`, () => {
      const dockerfile = readFileSync(join(repoRoot(), image), "utf8");
      const installIndex = dockerfile.indexOf(
        "RUN bun install --frozen-lockfile",
      );
      expect(installIndex).toBeGreaterThan(-1);
      const beforeInstall = dockerfile.slice(0, installIndex);
      const missing = members.filter(
        (manifest) => !beforeInstall.includes(`COPY ${manifest} `),
      );
      expect(missing).toEqual([]);
    });
  }
});
