import { resolver } from 'hono-openapi';
import type { Type } from 'arktype';

// hono-openapi 1.x accepts `resolver()` output in a route's `responses` schema
// position, but types `requestBody.content[].schema` as a raw OpenAPI
// SchemaObject — so `resolver()` is not assignable there even though it produces
// a valid schema object at runtime. Interchange sidesteps this by documenting
// request bodies through the `validator("json", …)` middleware; our routes keep
// their existing manual validation (swapping in `validator` would change the
// 400 error shape), so we document the body in `describeRoute` instead and wrap
// the single unavoidable cast here rather than scattering it across routes.
export function requestBodySchema(schema: Type<unknown>): Record<string, unknown> {
  return resolver(schema) as unknown as Record<string, unknown>;
}
