// Re-export of the drizzle predicate builders list-agents uses. This exists so
// list-agents.test.ts can mock these via this local module path instead of
// `mock.module('drizzle-orm', ...)`. The latter is process-global in Bun and
// leaked descriptor builders into every other suite that introspects real
// drizzle SQL (workflow and agents tests), failing them order-dependently
// (CL-1825). Mocking this narrow seam keeps the blast radius to list-agents.
export { and, desc, eq, inArray, isNull, or } from 'drizzle-orm';
