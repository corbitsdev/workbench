import { describe, expect, it } from 'bun:test';
import { buildToolGrantRows, TOOL_GRANT_RESOURCE_PREFIX } from './tool-grants';

const scope = { tenantId: 'tnt_1', principalId: 'prn_1' };
const now = new Date('2026-06-08T00:00:00.000Z');

describe('buildToolGrantRows', () => {
  it('builds one allow/invoke/system grant per tool, scoped to the principal', () => {
    const rows = buildToolGrantRows(['exa_search', 'granola_list_notes'], scope, now);
    expect(rows).toHaveLength(2);
    const exa = rows.find((r) => r.resource === `${TOOL_GRANT_RESOURCE_PREFIX}exa_search`);
    expect(exa).toBeDefined();
    expect(exa).toMatchObject({
      tenantId: 'tnt_1',
      principalId: 'prn_1',
      roleId: null,
      action: 'invoke',
      effect: 'allow',
      origin: 'system',
      conditions: null,
      expiresAt: null,
    });
    expect(exa?.id.startsWith('grt_')).toBe(true);
    expect(exa?.createdAt).toEqual(now);
  });

  it('de-duplicates repeated tool names', () => {
    const rows = buildToolGrantRows(['exa_search', 'exa_search'], scope, now);
    expect(rows).toHaveLength(1);
  });

  it('returns no rows for an empty tool list', () => {
    expect(buildToolGrantRows([], scope, now)).toEqual([]);
  });

  it('assigns a distinct id to each grant', () => {
    const rows = buildToolGrantRows(['a', 'b', 'c'], scope, now);
    const ids = new Set(rows.map((r) => r.id));
    expect(ids.size).toBe(3);
  });
});
