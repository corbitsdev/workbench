import { describe, expect, it, mock } from 'bun:test';
import * as intxDb from '@intx/db';

// The tenant resolves a credential for 'attio' only; every other provider
// resolves to null. 'linear' is made to THROW to model an ambiguous match / DB
// error — which must hide the tool (fail-closed), never show it.
const resolveCredentialRequirement = (async (
  _db: unknown,
  _tenantId: string,
  req: { providerName: string }
) => {
  if (req.providerName === 'attio') return { secret: 'secret', providerId: 'prov-attio' };
  if (req.providerName === 'linear') throw new Error('Ambiguous credential match');
  return null;
}) as typeof intxDb.resolveCredentialRequirement;

mock.module('@intx/db', () => ({ ...intxDb, resolveCredentialRequirement }));

const { listAvailableToolSummaries, getAvailableToolDetail } = await import('./tenant-tools');

const db = {} as unknown as Parameters<typeof listAvailableToolSummaries>[0];

describe('tenant-tools availability', () => {
  it('includes credentialed-provider tools and excludes uncredentialed ones', async () => {
    const names = (await listAvailableToolSummaries(db, 'tenant-1')).map((s) => s.name);
    expect(names).toContain('attio_query_records');
  });

  it('always includes context/hub-backed tools regardless of credentials', async () => {
    const summaries = await listAvailableToolSummaries(db, 'tenant-1');
    expect(summaries.filter((s) => s.providerName === 'workbench').length).toBeGreaterThan(0);
  });

  it('hides a provider whose resolution throws (ambiguity / DB error), never shows it', async () => {
    const names = (await listAvailableToolSummaries(db, 'tenant-1')).map((s) => s.name);
    expect(names.some((n) => n.startsWith('linear_'))).toBe(false);
    const detail = await getAvailableToolDetail(db, 'tenant-1', 'linear_list_issues');
    expect(detail).toBeNull();
  });

  it('returns detail with input schema for an available tool', async () => {
    const detail = await getAvailableToolDetail(db, 'tenant-1', 'attio_query_records');
    expect(detail).not.toBeNull();
    expect(detail?.providerName).toBe('attio');
    const schema = detail?.inputSchema as { properties?: Record<string, unknown> } | null;
    expect(schema?.properties).toBeDefined();
  });

  it('returns null for an unknown tool', async () => {
    expect(await getAvailableToolDetail(db, 'tenant-1', 'not_a_real_tool')).toBeNull();
  });
});
