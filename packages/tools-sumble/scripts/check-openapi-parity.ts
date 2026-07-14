import {
  SUMBLE_V9_OPERATION_COVERAGE,
  operationKey,
} from "../src/operation-coverage.ts";

const url = "https://api.sumble.com/openapi.json?version=v9";
const spec = (await fetch(url).then((r) => r.json())) as {
  paths?: Record<string, Record<string, unknown>>;
};

const liveOps: string[] = [];
for (const [p, methods] of Object.entries(spec.paths ?? {})) {
  for (const meth of Object.keys(methods)) {
    if (["get", "post"].includes(meth)) {
      liveOps.push(operationKey(meth, p));
    }
  }
}
liveOps.sort();

const covered = SUMBLE_V9_OPERATION_COVERAGE.map((op) =>
  operationKey(op.method, op.path),
);
covered.sort();

const missing = liveOps.filter((op) => !covered.includes(op));
const extra = covered.filter((op) => !liveOps.includes(op));

if (missing.length > 0 || extra.length > 0) {
  console.error("OpenAPI parity mismatch");
  if (missing.length > 0) console.error("Missing coverage:", missing);
  if (extra.length > 0) console.error("Stale coverage entries:", extra);
  process.exit(1);
}

console.log(`OK: ${liveOps.length} v9 operations covered by hub tools`);
