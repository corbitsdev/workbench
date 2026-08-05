// Placeholder behind a declared top-level script name. The set of top-level
// script names is fixed in the root package.json; later work replaces the
// implementation behind a name, never the name itself. Until then the script
// must fail loudly rather than pass vacuously.
const name = process.argv[2];
if (!name) {
  console.error("usage: bun run scripts/not-implemented.ts <script-name>");
  process.exit(1);
}
console.error(`${name}: not implemented yet`);
process.exit(1);
