import type { Sql } from 'postgres';
import { type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { schema as intx } from '@intx/db';
import * as workbench from './schema';

export const schema = { ...intx, ...workbench };
export type HubDb = PostgresJsDatabase<typeof schema> & { $client: Sql<{}> };
