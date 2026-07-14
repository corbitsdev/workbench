import { optionalPositiveInteger, optionalString } from "./shared";

export type ListPagination = {
  first: number;
  after: string | null;
};

export function resolveListPagination(
  args: Record<string, unknown>,
  fallback: number,
  max: number,
): ListPagination {
  const limitArg = args.limit ?? args.first;
  const first = optionalPositiveInteger(limitArg, fallback, max);
  const after = optionalString(args.cursor ?? args.after);
  return { first, after };
}

export function paginationVariables(
  pagination: ListPagination,
): Record<string, unknown> {
  if (pagination.after === null) {
    return { first: pagination.first };
  }
  return { first: pagination.first, after: pagination.after };
}

export function connectionResult(connection: unknown): unknown {
  if (
    typeof connection !== "object" ||
    connection === null ||
    !("nodes" in connection)
  ) {
    return connection;
  }
  const record = connection as Record<string, unknown>;
  const pageInfo = record.pageInfo;
  const cursor =
    typeof pageInfo === "object" &&
    pageInfo !== null &&
    "endCursor" in pageInfo &&
    typeof (pageInfo as { endCursor?: unknown }).endCursor === "string"
      ? (pageInfo as { endCursor: string }).endCursor
      : null;
  const hasNextPage =
    typeof pageInfo === "object" &&
    pageInfo !== null &&
    "hasNextPage" in pageInfo &&
    typeof (pageInfo as { hasNextPage?: unknown }).hasNextPage === "boolean"
      ? (pageInfo as { hasNextPage: boolean }).hasNextPage
      : false;
  return {
    nodes: record.nodes,
    pageInfo: {
      endCursor: cursor,
      hasNextPage,
    },
  };
}