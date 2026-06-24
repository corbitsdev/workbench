/// <reference types="bun" />
import '../test-setup';
import { afterEach, describe, expect, it } from 'bun:test';
import { createMyraThread, deleteMyraThread, listMyraThreads, renameMyraThread } from './hub-api';

const originalFetch = globalThis.fetch;

type Call = { url: string; method: string; body: unknown };

function stubFetch(body: unknown, capture?: Call[]): void {
  globalThis.fetch = ((url: string, init?: RequestInit) => {
    capture?.push({
      url: String(url),
      method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(init.body as string) : undefined,
    });
    return Promise.resolve({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: () => Promise.resolve(body),
    } as unknown as Response);
  }) as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const thread = {
  id: 'map-1',
  instanceId: 'inst-1',
  label: 'Chat',
  createdAt: '2026-01-01T00:00:00.000Z',
};

describe('hub-api Myra threads', () => {
  it('lists threads and parses the response', async () => {
    const calls: Call[] = [];
    stubFetch({ threads: [thread] }, calls);
    const result = await listMyraThreads();
    expect(result).toEqual([thread]);
    expect(calls[0]?.method).toBe('GET');
    expect(calls[0]?.url).toContain('/api/v1/me/myra/threads');
  });

  it('throws on a malformed list response', async () => {
    stubFetch({ threads: [{ id: 'x' }] });
    await expect(listMyraThreads()).rejects.toThrow(/Invalid Myra threads response/);
  });

  it('creates a thread, sending the label', async () => {
    const calls: Call[] = [];
    stubFetch({ thread, created: true }, calls);
    const result = await createMyraThread('Pricing');
    expect(result).toEqual(thread);
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.body).toEqual({ label: 'Pricing' });
  });

  it('renames a thread via PATCH', async () => {
    const calls: Call[] = [];
    stubFetch({ thread: { ...thread, label: 'Renamed' } }, calls);
    const result = await renameMyraThread('map-1', 'Renamed');
    expect(result.label).toBe('Renamed');
    expect(calls[0]?.method).toBe('PATCH');
    expect(calls[0]?.url).toContain('/api/v1/me/myra/threads/map-1');
    expect(calls[0]?.body).toEqual({ label: 'Renamed' });
  });

  it('deletes a thread via DELETE', async () => {
    const calls: Call[] = [];
    stubFetch({ deleted: true }, calls);
    await deleteMyraThread('map-1');
    expect(calls[0]?.method).toBe('DELETE');
    expect(calls[0]?.url).toContain('/api/v1/me/myra/threads/map-1');
  });
});
