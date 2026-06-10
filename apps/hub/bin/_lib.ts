/* eslint-disable no-console */

/**
 * Shared utilities for hub admin scripts.
 */

export type CookieJar = string[];

export function env(name: string, fallback: string): string;
export function env(name: string, fallback?: string): string | undefined;
export function env(name: string, fallback?: string): string | undefined {
  return process.env[name] ?? fallback;
}

export async function api(
  base: string,
  method: string,
  path: string,
  body?: unknown,
  cookies: CookieJar = []
): Promise<{ status: number; data: unknown; cookies: CookieJar }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (cookies.length > 0) headers['Cookie'] = cookies.join('; ');

  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });

  const nextCookies = [...cookies];
  for (const sc of res.headers.getSetCookie()) {
    const name = sc.split('=')[0];
    const value = sc.split(';')[0];
    if (!name || !value) continue;
    const idx = nextCookies.findIndex((c) => c.startsWith(`${name}=`));
    if (idx >= 0) nextCookies[idx] = value;
    else nextCookies.push(value);
  }

  let data: unknown = null;
  if ((res.headers.get('content-type') ?? '').includes('json')) data = await res.json();
  return { status: res.status, data, cookies: nextCookies };
}

export function makeLogger(prefix: string): (message: string) => void {
  return (message: string) => console.log(`[${prefix}] ${message}`);
}

export function makeFail(prefix: string): (label: string, status: number, data: unknown) => never {
  return (label: string, status: number, data: unknown): never => {
    console.error(`[${prefix}] FAIL ${label}: ${status}`);
    console.error(`[${prefix}]   ${JSON.stringify(data)}`);
    process.exit(1);
  };
}

export async function signIn(
  base: string,
  email: string,
  password: string,
  sessionToken: string | undefined,
  log: (msg: string) => void,
  fail: (label: string, status: number, data: unknown) => never
): Promise<CookieJar> {
  if (sessionToken) {
    log('Using SESSION_TOKEN for authentication');
    return [
      `better-auth.session_token=${sessionToken}`,
      `__Secure-better-auth.session_token=${sessionToken}`,
    ];
  }
  const res = await api(base, 'POST', '/api/auth/sign-in/email', { email, password });
  if (res.cookies.length === 0) fail('sign in', res.status, res.data);
  log(`Signed in as ${email}`);
  return res.cookies;
}
