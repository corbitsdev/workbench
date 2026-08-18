// Concurrent pack/materialize of independent `@corbits/*-tools` directories.
// The nine packages have no inter-pack dependency — each `bun build` is
// self-contained — so they can run together. A changed package still
// rematerializes: skip is opt-in and only fires when the caller already
// knows the content hash matches an on-disk materialize
// (`sha512Integrity` in `./publish.ts`).

export type MaterializePackagesArgs<T> = {
  packageDirs: readonly string[];
  materialize: (packageDir: string) => Promise<T>;
  concurrency?: number;
  shouldSkip?: (packageDir: string) => boolean | Promise<boolean>;
};

export type MaterializedPackage<T> =
  | { packageDir: string; status: "skipped" }
  | { packageDir: string; status: "ok"; value: T };

/**
 * Run independent pack/materialize work across `packageDirs`. Results
 * stay in input order. Default concurrency is one worker per directory
 * (equivalent to `Promise.all`); pass `concurrency` to cap the pool.
 */
export async function materializePackages<T>(
  args: MaterializePackagesArgs<T>,
): Promise<MaterializedPackage<T>[]> {
  if (args.packageDirs.length === 0) return [];
  const concurrency = args.concurrency ?? args.packageDirs.length;
  if (concurrency < 1) {
    throw new Error(
      `materializePackages: concurrency must be >= 1, got ${String(concurrency)}`,
    );
  }
  return mapPool(args.packageDirs, concurrency, async (packageDir) => {
    if (args.shouldSkip !== undefined && (await args.shouldSkip(packageDir))) {
      return { packageDir, status: "skipped" };
    }
    return {
      packageDir,
      status: "ok",
      value: await args.materialize(packageDir),
    };
  });
}

async function mapPool<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      const item = items[index];
      if (item === undefined) return;
      results[index] = await fn(item);
    }
  }
  const workerCount = Math.min(concurrency, items.length);
  const workers: Promise<void>[] = [];
  for (let i = 0; i < workerCount; i += 1) {
    workers.push(worker());
  }
  await Promise.all(workers);
  return results;
}
