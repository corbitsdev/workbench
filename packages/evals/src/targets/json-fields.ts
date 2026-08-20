// Shared field readers for parsing hub API JSON responses — both
// real-target.ts and fire-routine.ts read fields off `unknown` response
// bodies and need the same loud-on-missing behavior.
export function stringField(
  data: unknown,
  field: string,
  what: string,
): string {
  if (typeof data === "object" && data !== null && field in data) {
    const value = (data as Record<string, unknown>)[field];
    if (typeof value === "string" && value !== "") return value;
  }
  throw new Error(
    `${what}: missing string field "${field}": ${JSON.stringify(data)}`,
  );
}

export function arrayField(
  data: unknown,
  field: string,
  what: string,
): unknown[] {
  if (typeof data === "object" && data !== null && field in data) {
    const value = (data as Record<string, unknown>)[field];
    if (Array.isArray(value)) return value;
  }
  throw new Error(
    `${what}: missing array field "${field}": ${JSON.stringify(data)}`,
  );
}
