type FindFirstHandler = () => Promise<unknown>;

export function createFakeDrizzleQuery(handlers: {
  findFirst?: Record<string, FindFirstHandler>;
}) {
  return {
    query: new Proxy(
      {},
      {
        get(_target, table: string) {
          const findFirst = handlers.findFirst?.[table] ?? (async () => null);
          return { findFirst };
        },
      },
    ),
  };
}
