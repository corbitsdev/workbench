/// <reference types="bun" />
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { ApiError } from '@intx/hub-client';
import { createHubTransport } from './instance-transport';

// instance-transport runs through the real fetch / EventSource boundaries; we
// stub the globals rather than module-mocking shared-event-stream, which would
// leak across files under bun.
const originalFetch = globalThis.fetch;
const originalEventSource = globalThis.EventSource;

interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}

interface StubResponse {
  ok?: boolean;
  status?: number;
  body?: unknown;
  bodyThrows?: boolean;
}

function installFetch(response: StubResponse): FetchCall[] {
  const calls: FetchCall[] = [];
  const stub = mock((url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const res = {
      ok: response.ok ?? true,
      status: response.status ?? 200,
      json: () =>
        response.bodyThrows
          ? Promise.reject(new Error('not json'))
          : Promise.resolve(response.body),
    };
    return Promise.resolve(res as unknown as Response);
  });
  globalThis.fetch = stub as unknown as typeof fetch;
  return calls;
}

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  url: string;
  withCredentials: boolean;
  closed = false;
  listeners: Record<string, (event: MessageEvent) => void> = {};
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(url: string, opts?: { withCredentials?: boolean }) {
    this.url = url;
    this.withCredentials = opts?.withCredentials ?? false;
    FakeEventSource.instances.push(this);
  }

  addEventListener(name: string, cb: (event: MessageEvent) => void): void {
    this.listeners[name] = cb;
  }

  close(): void {
    this.closed = true;
  }
}

describe('createHubTransport', () => {
  beforeEach(() => {
    (
      globalThis as unknown as { window: { happyDOM: { setURL: (u: string) => void } } }
    ).window.happyDOM.setURL('http://localhost/');
    FakeEventSource.instances = [];
    globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    globalThis.EventSource = originalEventSource;
  });

  it('issues a credentialed GET with no content-type and no body', async () => {
    const calls = installFetch({ body: { ok: true } });

    const result = await createHubTransport().fetch('GET', '/instances/i1/state');
    expect(result).toEqual({ ok: true });
    expect(calls[0]!.url).toContain('/instances/i1/state');
    expect(calls[0]!.init?.method).toBe('GET');
    expect(calls[0]!.init?.credentials).toBe('include');
    expect(calls[0]!.init?.headers).toBeUndefined();
  });

  it('serializes the body and sets the content-type on a POST', async () => {
    const calls = installFetch({ body: { sent: true } });

    await createHubTransport().fetch('POST', '/instances/i1/mail', { text: 'hi' });
    expect(calls[0]!.init?.method).toBe('POST');
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ text: 'hi' });
    expect((calls[0]!.init!.headers as Record<string, string>)['Content-Type']).toBe(
      'application/json'
    );
  });

  it('returns undefined for a 204 response', async () => {
    installFetch({ status: 204, body: undefined });

    expect(await createHubTransport().fetch('DELETE', '/instances/i1')).toBeUndefined();
  });

  it('throws an ApiError carrying the server error code and message', async () => {
    installFetch({
      ok: false,
      status: 409,
      body: { error: { code: 'conflict', message: 'already running' } },
    });

    const promise = createHubTransport().fetch('POST', '/instances/i1/sessions');
    await expect(promise).rejects.toBeInstanceOf(ApiError);
    await expect(promise).rejects.toMatchObject({
      status: 409,
      code: 'conflict',
      message: 'already running',
    });
  });

  it('falls back to an unknown code and HTTP message when the error body is not JSON', async () => {
    installFetch({ ok: false, status: 500, bodyThrows: true });

    await expect(createHubTransport().fetch('GET', '/instances/i1')).rejects.toMatchObject({
      status: 500,
      code: 'unknown',
      message: 'HTTP 500',
    });
  });

  it('subscribe opens a credentialed EventSource for the resolved path and closes on unsubscribe', () => {
    const onEvent = mock();
    const unsubscribe = createHubTransport().subscribe('/instances/i1/events', onEvent);

    const source = FakeEventSource.instances[0]!;
    expect(source.url).toContain('/instances/i1/events');
    expect(source.withCredentials).toBe(true);
    expect(typeof source.listeners.message).toBe('function');

    unsubscribe();
    expect(source.closed).toBe(true);
  });

  it('subscribe honors a custom event name', () => {
    const onEvent = mock();
    const unsubscribe = createHubTransport().subscribe('/instances/i1/events', onEvent, {
      eventName: 'turn',
    });

    const source = FakeEventSource.instances[0]!;
    expect(typeof source.listeners.turn).toBe('function');
    unsubscribe();
  });
});
