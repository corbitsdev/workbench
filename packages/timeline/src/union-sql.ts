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

function inSet(column: SQL, values: readonly string[]): SQL {
  if (values.length === 1) {
    return sql`${column} = ${values[0]}`;
  }
  const bound = values.map((value) => sql`${value}`);
  return sql`${column} in (${sql.join(bound, sql`, `)})`;
}

function scopePredicate(
  scope: TenantScope | PrincipalScope,
  values: readonly string[],
): SQL {
  if ("column" in scope) {
    return inSet(sql`src.${sql.identifier(scope.column)}`, values);
  }
  if ("anyColumn" in scope) {
    const alternatives = scope.anyColumn.map((column) =>
      inSet(sql`src.${sql.identifier(column)}`, values),
    );
    return sql`(${sql.join(alternatives, sql` or `)})`;
  }
  const { table, localColumn, foreignColumn, scopeColumn } = scope.exists;
  return sql`exists (select 1 from ${sql.identifier(table)} scope_join where scope_join.${sql.identifier(foreignColumn)} = src.${sql.identifier(localColumn)} and ${inSet(sql`scope_join.${sql.identifier(scopeColumn)}`, values)})`;
}

// Rows strictly after the cursor in (ts desc, source_table asc, id asc) order.
// `cursor.timestamp` is the verbatim Postgres text rendering of the boundary
// row's timestamptz, so casting it back compares at full microsecond
// precision — reformatting through a JS Date would truncate to milliseconds
// and silently drop sub-millisecond neighbors at the page boundary.
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
  assertValidScope(args.scope);
  const conditions: SQL[] = [
    scopePredicate(descriptor.tenantScope, [args.scope.tenantId]),
    scopePredicate(descriptor.principalScope, args.scope.principalIds),
  ];
  if (descriptor.filterSql !== undefined) {
    conditions.push(sql`(${sql.raw(descriptor.filterSql)})`);
  }
  if (args.cursor !== undefined) {
    conditions.push(keysetPredicate(descriptor, args.cursor));
  }
  const where = sql.join(conditions, sql` and `);
  return sql`(select cast(src.${sql.identifier(descriptor.idColumn)} as text) as id, ${descriptor.kind} as kind, ${descriptor.table} as source_table, src.${sql.identifier(descriptor.timestamp.column)}::timestamptz as ts, src.${sql.identifier(descriptor.timestamp.column)}::timestamptz::text as ts_text, (${sql.raw(descriptor.summarySql)}) as summary from ${sql.identifier(descriptor.table)} src where ${where} order by ts desc, id asc limit ${args.limit})`;
}

// The full page query: one keyset-limited branch per registered source,
// merged and re-sorted on the composite key (ts desc, source_table, id).
// `ts_text` carries each row's timestamp losslessly for cursor construction.
export function buildTimelineUnionQuery(args: TimelineQueryArgs): SQL {
  assertValidLimit(args.limit);
  assertValidScope(args.scope);
  const branches = timelineSources.map((descriptor) =>
    buildTimelineBranchQuery(descriptor, args),
  );
  const union = sql.join(branches, sql` union all `);
  return sql`select id, kind, source_table, ts, ts_text, summary from (${union}) entries order by ts desc, source_table asc, id asc limit ${args.limit}`;
}

function assertValidLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error(
      `Timeline page limit must be a positive integer, got ${limit}`,
    );
  }
}

function assertValidScope(scope: TimelineScope): void {
  if (scope.principalIds.length === 0) {
    throw new Error("Timeline scope requires at least one principal id");
  }
}
