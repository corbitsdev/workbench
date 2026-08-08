/** A destination the command palette can jump to. Built only from routes the
 * app shell actually renders — this module never invents a destination. */
export type StaticCommand = {
  readonly id: string;
  readonly title: string;
  readonly category: "pages";
  readonly path: string;
};

/** The minimal shape a route table needs to become palette commands. */
export type StaticRoute = {
  readonly path: string;
  readonly label: string;
};

export function buildStaticCommands(
  routes: readonly StaticRoute[],
): readonly StaticCommand[] {
  return routes.map((route) => ({
    id: `route:${route.path}`,
    title: route.label,
    category: "pages",
    path: route.path,
  }));
}

/** Case-insensitive substring match; an empty or whitespace-only query matches everything. */
export function matchesQuery(title: string, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return true;
  return title.toLowerCase().includes(needle);
}
