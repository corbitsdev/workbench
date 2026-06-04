// Production server for GTM Workbench web SPA.
// Serves the Vite build output from dist/ and proxies API requests
// to the hub backend so better-auth cookies stay same-origin.

const API_URL = process.env['API_URL']?.replace(/\/+$/, '') || 'http://localhost:4000';
const PORT = Number(process.env['PORT'] || 3000);

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'te',
  'trailer',
  'upgrade',
  'proxy-authorization',
  'proxy-authenticate',
]);

async function handleRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);

  // Proxy API and sidecar routes to the hub backend
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/sidecar/')) {
    const target = `${API_URL}${url.pathname}${url.search}`;
    const headers = new Headers();
    for (const [k, v] of req.headers) {
      if (HOP_BY_HOP.has(k.toLowerCase())) continue;
      headers.set(k, v);
    }

    try {
      const res = await fetch(target, {
        method: req.method,
        headers,
        body: req.method !== 'GET' && req.method !== 'HEAD' ? req.body : undefined,
      });

      const resHeaders = new Headers();
      for (const [k, v] of res.headers) {
        if (HOP_BY_HOP.has(k.toLowerCase())) continue;
        resHeaders.set(k, v);
      }

      return new Response(res.body, {
        status: res.status,
        statusText: res.statusText,
        headers: resHeaders,
      });
    } catch (err) {
      console.error('Proxy error:', err);
      return new Response(
        JSON.stringify({ error: 'Failed to reach API backend', details: String(err) }),
        { status: 502, headers: { 'Content-Type': 'application/json' } }
      );
    }
  }

  // Serve static files from dist/
  const filePath = url.pathname === '/' ? '/index.html' : url.pathname;
  const distFile = Bun.file(`./dist${filePath}`);

  if (await distFile.exists()) {
    return new Response(distFile);
  }

  // SPA fallback — client-side routing
  return new Response(Bun.file('./dist/index.html'));
}

Bun.serve({
  port: PORT,
  hostname: '0.0.0.0',
  fetch: handleRequest,
});

console.log(`Web server listening on port ${PORT}, proxying API to ${API_URL}`);
