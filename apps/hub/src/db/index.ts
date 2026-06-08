import { type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { schema as intxSchema } from '@intx/db';
import * as schema from './schema';

export { schema };

/** Hub database type that merges the Interchange schema with workbench schema. */
export type HubDb = PostgresJsDatabase<typeof intxSchema & typeof schema>;
