import { sql, type SQL } from "drizzle-orm";

import type { TimelineCursor } from "./cursor";
import type {
  PrincipalScope,
  TenantScope,
  TimelineScope,
  TimelineSourceDescriptor,
} from "./descriptor";
import { timelineSources } from "./registry";

export type TimelineQueryArgs = {
  scope: TimelineScope;
  limit: number;
  cursor?: TimelineCursor;
};

function scopePredicate(
  scope: TenantScope | PrincipalScope,
  value: string,
): SQL {
  if ("column" in scope) {
    return sql`src.${sql.identifier(scope.column)} = ${value}`;
  }
  if ("anyColumn" in scope) {
    const alternatives = scope.anyColumn.map(
      (column) => sql`src.${sql.identifier(column)} = ${value}`,
    );
    return sql`(${sql.join(alternatives, sql` or `)})`;
  }
  const { table, localColumn, foreignColumn, scopeColumn } = scope.exists;
  return sql`exists (select 1 from ${sql.identifier(table)} scope_join where scope_join.${sql.identifier(foreignColumn)} = src.${sql.identifier(localColumn)} and scope_join.${sql.identifier(scopeColumn)} = ${value})`;
}

// Rows strictly after the cursor in (ts desc, source_table asc, id asc) order.
function keysetPredicate(
  descriptor: TimelineSourceDescriptor,
  cursor: TimelineCursor,
): SQL {
  const ts = sql`src.${sql.identifier(descriptor.timestamp.column)}::timestamptz`;
  const id = sql`cast(src.${sql.identifier(descriptor.idColumn)} as text)`;
  return sql`(${ts} < ${cursor.timestamp}::timestamptz or (${ts} = ${cursor.timestamp}::timestamptz and (${descriptor.table} > ${cursor.sourceTable} or (${descriptor.table} = ${cursor.sourceTable} and ${id} > ${cursor.id}))))`;
}

export function buildTimelineBranchQuery(
  descriptor: TimelineSourceDescriptor,
  args: TimelineQueryArgs,
): SQL {
  assertValidLimit(args.limit);
  const conditions: SQL[] = [
    scopePredicate(descriptor.tenantScope, args.scope.tenantId),
    scopePredicate(descriptor.principalScope, args.scope.principalId),
  ];
  if (descriptor.filterSql !== undefined) {
    conditions.push(sql`(${sql.raw(descriptor.filterSql)})`);
  }
  if (args.cursor !== undefined) {
    conditions.push(keysetPredicate(descriptor, args.cursor));
  }
  const where = sql.join(conditions, sql` and `);
  return sql`(select cast(src.${sql.identifier(descriptor.idColumn)} as text) as id, ${descriptor.kind} as kind, ${descriptor.table} as source_table, src.${sql.identifier(descriptor.timestamp.column)}::timestamptz as ts, (${sql.raw(descriptor.summarySql)}) as summary from ${sql.identifier(descriptor.table)} src where ${where} order by ts desc, id asc limit ${args.limit})`;
}

// The full page query: one keyset-limited branch per registered source,
// merged and re-sorted on the composite key (ts desc, source_table, id).
export function buildTimelineUnionQuery(args: TimelineQueryArgs): SQL {
  assertValidLimit(args.limit);
  const branches = timelineSources.map((descriptor) =>
    buildTimelineBranchQuery(descriptor, args),
  );
  const union = sql.join(branches, sql` union all `);
  return sql`select id, kind, source_table, ts, summary from (${union}) entries order by ts desc, source_table asc, id asc limit ${args.limit}`;
}

function assertValidLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error(
      `Timeline page limit must be a positive integer, got ${limit}`,
    );
  }
}
