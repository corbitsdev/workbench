import type { Sql } from "postgres";
import { type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { schema as intx } from "@intx/db";
import * as workbench from "./schema";

export const schema = { ...intx, ...workbench };

// Intersect the ORIGINAL `@intx/db` schema type with the workbench tables
// rather than deriving from the spread-reconstructed `typeof schema`. The
// spread rebuilds a fresh object type whose intx table properties are
// re-homogenized; under `exactOptionalPropertyTypes: true` that reconstruction
// diverges from the original intx schema type that interchange helpers accept
// as `PostgresJsDatabase<typeof intxSchema>`, so a HubDb built off `typeof
// schema` stops being assignable to those helpers. Keeping intx's own
// property types intact via the intersection preserves that assignability
// while still carrying the workbench tables for `db.query`.
export type HubSchema = typeof intx & typeof workbench;
export type HubDb = PostgresJsDatabase<HubSchema> & { $client: Sql<{}> };
