const url = "https://api.sumble.com/openapi.json?version=v9";
const spec = (await fetch(url).then((r) => r.json())) as {
  paths?: Record<string, Record<string, unknown>>;
};
for (const [p, methods] of Object.entries(spec.paths ?? {}).sort((a, b) =>
  a[0].localeCompare(b[0]),
)) {
  for (const meth of Object.keys(methods).filter((m) =>
    ["get", "post", "put", "patch", "delete"].includes(m),
  )) {
    console.log(`${meth.toUpperCase().padEnd(6)} ${p}`);
  }
}
