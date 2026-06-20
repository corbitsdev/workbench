import { type } from 'arktype';
import { createClient, type ApiClient, type HttpMethod } from '@workbench/openapi-arktype';
import { api, type CookieJar } from '../_lib';

// Typed hub client for the admin CLI. It pairs the vendored openapi-arktype
// runtime (which loads the hub's live /openapi.json for operation discovery and
// per-response arktype validators) with the cookie-jar `api()` executor from
// _lib (authenticated HTTP). The CLI drives the hub purely through whatever the
// spec advertises — no hard-coded endpoint list.

export interface OperationSummary {
  tag: string;
  method: HttpMethod;
  path: string;
  operationId?: string;
  summary?: string;
}

export interface CallOptions {
  // Values for `:name` path segments, e.g. { deploymentId: "..." }.
  pathParams?: Record<string, string>;
  // Query string parameters; undefined values are skipped.
  query?: Record<string, string | undefined>;
  // JSON request body.
  body?: unknown;
}

export interface CallResult {
  status: number;
  data: unknown;
  // True when the spec declares a JSON response for this status and the body
  // validated against it. Undefined when the spec has no schema to check.
  valid?: boolean;
}

export interface HubClient {
  baseUrl: string;
  spec: ApiClient;
  // Operations the spec advertises, grouped-ready (sorted by tag then path).
  operations(): OperationSummary[];
  // Execute an operation, validating the response against the spec when possible.
  call(method: HttpMethod, path: string, opts?: CallOptions): Promise<CallResult>;
}

function buildPath(
  template: string,
  pathParams: Record<string, string> | undefined,
  query: Record<string, string | undefined> | undefined
): string {
  let path = template;
  if (pathParams) {
    for (const [key, value] of Object.entries(pathParams)) {
      path = path
        .replace(`:${key}`, encodeURIComponent(value))
        .replace(`{${key}}`, encodeURIComponent(value));
    }
  }
  if (query) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) params.set(key, value);
    }
    const qs = params.toString();
    if (qs) path = `${path}?${qs}`;
  }
  return path;
}

export async function createHubClient(opts: {
  baseUrl: string;
  cookies: CookieJar;
}): Promise<HubClient> {
  const spec = await createClient({ url: `${opts.baseUrl}/openapi.json` });

  function operations(): OperationSummary[] {
    const out: OperationSummary[] = [];
    for (const [path, item] of Object.entries(spec.api.paths)) {
      for (const [method, op] of Object.entries(item.operations)) {
        out.push({
          tag: op.tags[0] ?? 'Other',
          method: method as HttpMethod,
          path,
          operationId: op.operationId,
          summary: op.summary,
        });
      }
    }
    out.sort(
      (a, b) =>
        a.tag.localeCompare(b.tag) ||
        a.path.localeCompare(b.path) ||
        a.method.localeCompare(b.method)
    );
    return out;
  }

  async function call(
    method: HttpMethod,
    path: string,
    callOpts: CallOptions = {}
  ): Promise<CallResult> {
    const fullPath = buildPath(path, callOpts.pathParams, callOpts.query);
    const res = await api(
      opts.baseUrl,
      method.toUpperCase(),
      fullPath,
      callOpts.body,
      opts.cookies
    );

    const validators = spec.operation(method, path);
    const jsonValidator = validators?.responses?.[String(res.status)]?.['application/json'];
    let valid: boolean | undefined;
    if (jsonValidator) {
      valid = !(jsonValidator(res.data) instanceof type.errors);
    }

    return { status: res.status, data: res.data, ...(valid !== undefined ? { valid } : {}) };
  }

  return { baseUrl: opts.baseUrl, spec, operations, call };
}
