import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");
const dockerfilePath = resolve(repoRoot, "Dockerfile");
const interchangePath = resolve(repoRoot, "interchange");

const dockerfile = readFileSync(dockerfilePath, "utf8");
const match = dockerfile.match(
  /ARG INTERCHANGE_COMMIT=([0-9a-f]{40})/
);

if (!match) {
  console.error(
    "check-interchange-sync: could not find INTERCHANGE_COMMIT in Dockerfile"
  );
  process.exit(1);
}

const pinnedCommit = match[1];

let actualCommit: string;
try {
  const gitRoot = execSync("git rev-parse --show-toplevel", {
    cwd: interchangePath,
    encoding: "utf8",
  }).trim();

  if (gitRoot !== interchangePath) {
    console.error(
      "check-interchange-sync: interchange/ is not a git repository — is interchange checked out at the expected path?"
    );
    process.exit(1);
  }

  actualCommit = execSync("git rev-parse HEAD", {
    cwd: interchangePath,
    encoding: "utf8",
  }).trim();
} catch {
  console.error(
    "check-interchange-sync: could not read interchange git HEAD — is interchange checked out at the expected path?"
  );
  process.exit(1);
}

if (pinnedCommit !== actualCommit) {
  console.error(`check-interchange-sync: mismatch

  Dockerfile pins: ${pinnedCommit}
  interchange HEAD: ${actualCommit}

Update INTERCHANGE_COMMIT (and INTERCHANGE_SHA256) in Dockerfile to match,
or check out the pinned commit in interchange/.`);
  process.exit(1);
}

console.log(`check-interchange-sync: ok (${pinnedCommit.slice(0, 12)})`);
