// Runs a package.json script in every workspace package that defines it.
// Succeeds when no package defines it, so root gates stay green while the
// workspace is still empty.
import { Glob } from "bun";

const script = process.argv[2];
if (!script) {
  console.error("usage: bun run scripts/run-all.ts <script-name>");
  process.exit(1);
}

const glob = new Glob("{apps,packages,tools,workflows}/*/package.json");
let failures = 0;
let ran = 0;

for await (const manifestPath of glob.scan(".")) {
  const manifest = (await Bun.file(manifestPath).json()) as {
    name?: string;
    scripts?: Record<string, string>;
  };
  if (!manifest.scripts?.[script]) continue;
  ran += 1;
  const dir = manifestPath.slice(0, -"/package.json".length);
  const proc = Bun.spawn(["bun", "run", script], {
    cwd: dir,
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await proc.exited;
  if (code !== 0) {
    console.error(
      `${manifest.name ?? dir}: ${script} exited with code ${code}`,
    );
    failures += 1;
  }
}

if (ran === 0) console.log(`${script}: no workspace packages define it yet`);
process.exit(failures === 0 ? 0 : 1);
