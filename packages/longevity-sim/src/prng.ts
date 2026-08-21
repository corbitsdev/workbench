// mulberry32: small, fast, seeded PRNG — good enough for deterministic
// simulation, not for anything security-sensitive.
export function createRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pick<T>(rng: () => number, items: readonly T[]): T {
  if (items.length === 0) {
    throw new Error("pick: items must be non-empty");
  }
  const index = Math.floor(rng() * items.length);
  const item = items[Math.min(index, items.length - 1)];
  if (item === undefined) {
    throw new Error("pick: index out of range");
  }
  return item;
}
