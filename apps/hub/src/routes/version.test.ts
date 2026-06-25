import { describe, it, expect } from 'bun:test';
import { createSystemRouter } from './system';

describe('GET /version', () => {
  it('returns 200 with the hub build SHA', async () => {
    const app = createSystemRouter('abc1234');
    const res = await app.request('/version');
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ buildSha: 'abc1234' });
  });

  it('returns null buildSha when unset (local dev)', async () => {
    const app = createSystemRouter(null);
    const res = await app.request('/version');
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ buildSha: null });
  });
});
