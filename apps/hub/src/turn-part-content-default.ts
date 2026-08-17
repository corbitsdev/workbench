// Interchange's event-collector (`@intx/hub-sessions`) inserts `turn_part`
// rows for tool-call/tool-result parts with `content: null`, which
// `insertPart` then omits from the insert entirely — Drizzle emits the SQL
// `DEFAULT` keyword for that column. That is only safe when the deployed
// `turn_part.content` column carries a real default; on a deployment where
// it does not (see the "hub·event-collector-registry: Failed to persist
// event" log), every tool part fails to persist and the Runs panel goes
// blank for tool-call turns. This wraps the `db` handle passed to
// `createEventCollectorRegistry` so a `turn_part` insert that omits
// `content` gets the historical empty-string value instead of relying on a
// database-level default that may not exist. Only `turn_part` inserts are
// touched — every other table's insert passes through untouched.
import { turnPart } from "@intx/db/schema";
import type { DB } from "@intx/db";

type InsertBuilder = { values: (...args: unknown[]) => unknown };

function fillContent(value: unknown): unknown {
  if (value === null || typeof value !== "object" || "content" in value) {
    return value;
  }
  return { ...value, content: "" };
}

export function withTurnPartWriteDefaults(db: DB["db"]): DB["db"] {
  return new Proxy(db as object, {
    get(target, prop, receiver) {
      if (prop !== "insert") {
        return Reflect.get(target, prop, receiver);
      }
      const insert = Reflect.get(target, prop, target) as (
        table: unknown,
      ) => InsertBuilder;
      return (table: unknown) => {
        const builder = insert.call(target, table);
        if (table !== turnPart) {
          return builder;
        }
        // The event-collector always calls `.values(...)` directly and
        // awaits the result without further chaining, so only that method
        // needs interception here.
        const originalValues = builder.values.bind(builder);
        return {
          values: (values: unknown) =>
            originalValues(
              Array.isArray(values)
                ? values.map(fillContent)
                : fillContent(values),
            ),
        };
      };
    },
  }) as DB["db"];
}
