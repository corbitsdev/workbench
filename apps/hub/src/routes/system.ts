import { Hono } from 'hono';
import { describeRoute, resolver } from 'hono-openapi';
import { type } from 'arktype';

// System routes: liveness + build version.
//
// /health is a pure liveness probe (Railway hits it on every request) and stays
// free of deploy metadata. /version carries the build SHA so an operator can
// confirm which merged code is live without coupling it to the liveness path.
//
// buildSha is the Railway git commit SHA injected at deploy time (null in local
// dev). Hub and sidecar redeploy from the same commit on a staging push, so the
// hub SHA alone answers "is my merged code live?".
export function createSystemRouter(buildSha: string | null): Hono {
  const app = new Hono();

  app.get(
    '/health',
    describeRoute({
      tags: ['System'],
      summary: 'Liveness probe',
      description: 'Returns an empty object when the hub process is up.',
      responses: {
        200: {
          description: 'Hub is live',
          content: {
            'application/json': {
              schema: resolver(type({})),
            },
          },
        },
      },
    }),
    (c) => c.json({})
  );

  app.get(
    '/version',
    describeRoute({
      tags: ['System'],
      summary: 'Live build SHA',
      description:
        'Returns the Railway git commit SHA injected at deploy time (null in local dev). Hub and sidecar redeploy from the same commit on a staging push, so the hub SHA alone answers "is my merged code live?".',
      responses: {
        200: {
          description: 'Live build SHA (null in local dev)',
          content: {
            'application/json': {
              schema: resolver(type({ buildSha: 'string | null' })),
            },
          },
        },
      },
    }),
    (c) => c.json({ buildSha })
  );

  return app;
}
