import { describe, expect, it } from 'bun:test';
import { loadProductImage } from './image';

function response(body: BodyInit | null, init: ResponseInit): Response {
  return new Response(body, init);
}

describe('loadProductImage', () => {
  it('returns a base64 ImageBlock on success', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const result = await loadProductImage('https://example.com/a.png', async () =>
      response(bytes, { status: 200, headers: { 'content-type': 'image/png' } })
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.image.source.kind).toBe('base64');
    expect(result.image.source.mimeType).toBe('image/png');
    expect(result.image.source.data).toBe(Buffer.from(bytes).toString('base64'));
  });

  it('flags an empty url without fetching', async () => {
    const result = await loadProductImage('');
    expect(result).toEqual({ ok: false, reason: 'no image link' });
  });

  it('flags an HTTP error response', async () => {
    const result = await loadProductImage('https://example.com/a.png', async () =>
      response(null, { status: 404 })
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.reason).toContain('404');
  });

  it('flags an empty body', async () => {
    const result = await loadProductImage('https://example.com/a.png', async () =>
      response(new Uint8Array([]), { status: 200, headers: { 'content-type': 'image/png' } })
    );
    expect(result.ok).toBe(false);
  });

  it('falls back to the URL extension for an octet-stream CDN response', async () => {
    const result = await loadProductImage('https://cdn.example.com/a.jpg?v=2', async () =>
      response(new Uint8Array([9, 9]), {
        status: 200,
        headers: { 'content-type': 'application/octet-stream' },
      })
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.image.source.mimeType).toBe('image/jpeg');
  });

  it('rejects a clearly non-image content-type', async () => {
    const result = await loadProductImage('https://example.com/a.png', async () =>
      response('<html>', { status: 200, headers: { 'content-type': 'text/html' } })
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.reason).toContain('text/html');
  });

  it('blocks non-https urls without fetching', async () => {
    let fetched = false;
    const result = await loadProductImage('http://example.com/a.png', async () => {
      fetched = true;
      return response(null, { status: 200 });
    });
    expect(fetched).toBe(false);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.reason).toContain('https');
  });

  it('blocks private and cloud-metadata hosts (SSRF guard)', async () => {
    for (const url of [
      'https://169.254.169.254/latest/meta-data/',
      'https://localhost/a.png',
      'https://10.0.0.5/a.png',
      'https://192.168.1.1/a.png',
    ]) {
      const result = await loadProductImage(url, async () => response(null, { status: 200 }));
      expect(result.ok).toBe(false);
    }
  });

  it('rejects an image whose content-length exceeds the cap', async () => {
    const result = await loadProductImage('https://example.com/a.png', async () =>
      response(new Uint8Array([1]), {
        status: 200,
        headers: { 'content-type': 'image/png', 'content-length': String(11 * 1024 * 1024) },
      })
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.reason).toContain('size');
  });
});
