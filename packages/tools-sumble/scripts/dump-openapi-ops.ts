const url = "https://api.sumble.com/openapi.json?version=v9";
const spec = (await fetch(url).then((r) => r.json())) as {
  paths?: Record<
    string,
    Record<
      string,
      {
        summary?: string;
        requestBody?: {
          content?: { "application/json"?: { schema?: { $ref?: string } } };
        };
      }
    >
  >;
};
for (const [p, methods] of Object.entries(spec.paths ?? {}).sort((a, b) =>
  a[0].localeCompare(b[0]),
)) {
  for (const [meth, op] of Object.entries(methods)) {
    if (!["get", "post", "put", "patch", "delete"].includes(meth)) continue;
    const ref =
      op.requestBody?.content?.["application/json"]?.schema?.$ref ?? "";
    console.log(`${meth.toUpperCase()} ${p} | ${op.summary ?? ""} | ${ref}`);
  }
}
