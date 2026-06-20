import { describe, it, expect } from 'bun:test';
import { createClient } from '@workbench/openapi-arktype';
import { groupByTag, operationInputs } from './menu';
import type { OperationSummary } from './client';

const SPEC = {
  openapi: '3.1.0',
  info: { title: 'T', version: '1' },
  paths: {
    '/workflows/deploy': {
      post: {
        tags: ['Workflows'],
        parameters: [
          {
            name: 'tenant',
            in: 'query',
            required: false,
            description: 'target slug',
            schema: { type: 'string' },
          },
        ],
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  id: { type: 'string', description: 'workflow id' },
                  steps: { type: 'object' },
                },
                required: ['id'],
              },
            },
          },
        },
        responses: { '200': { description: 'ok' } },
      },
    },
    '/members': {
      get: { tags: ['Members'], responses: { '200': { description: 'ok' } } },
    },
    '/things/{id}': {
      delete: {
        tags: ['Members'],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '204': { description: 'ok' } },
      },
    },
  },
};

async function loadSpec() {
  return createClient({ spec: SPEC });
}

describe('groupByTag', () => {
  it('groups operations by tag, sorted by tag name', () => {
    const ops: OperationSummary[] = [
      { tag: 'Workflows', method: 'post', path: '/workflows/deploy' },
      { tag: 'Members', method: 'get', path: '/members' },
      { tag: 'Members', method: 'delete', path: '/things/{id}' },
    ];
    const groups = groupByTag(ops);
    expect(groups.map((g) => g.tag)).toEqual(['Members', 'Workflows']);
    expect(groups[0]?.operations).toHaveLength(2);
    expect(groups[1]?.operations).toHaveLength(1);
  });
});

describe('operationInputs', () => {
  it('derives query param + required/optional body fields for a POST', async () => {
    const spec = await loadSpec();
    const inputs = operationInputs(spec, 'post', '/workflows/deploy');

    expect(inputs).toEqual([
      { name: 'tenant', kind: 'query', required: false, description: 'target slug' },
      { name: 'id', kind: 'body', required: true, description: 'workflow id' },
      { name: 'steps', kind: 'body', required: false },
    ]);
  });

  it('derives a required path param for a DELETE', async () => {
    const spec = await loadSpec();
    const inputs = operationInputs(spec, 'delete', '/things/{id}');
    expect(inputs).toEqual([{ name: 'id', kind: 'path', required: true }]);
  });

  it('returns no inputs for a parameterless GET', async () => {
    const spec = await loadSpec();
    expect(operationInputs(spec, 'get', '/members')).toEqual([]);
  });
});
