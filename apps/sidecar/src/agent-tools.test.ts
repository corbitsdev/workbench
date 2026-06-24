import { describe, it, expect, mock } from 'bun:test';
import { createMemoizingImportModule } from './agent-tools';

const fileUrl = (path: string, integrity?: string): string => {
  const base = `file:///${path}`;
  if (integrity === undefined) return base;
  return `${base}?integrity=${encodeURIComponent(integrity)}`;
};

describe('createMemoizingImportModule', () => {
  it('imports once for URLs that differ only in path but share an integrity', async () => {
    const module = { tool: 'shared' };
    const inner = mock(async () => module);
    const importModule = createMemoizingImportModule(inner);

    const a = await importModule(fileUrl('agent-a/pkg/index.js', 'sha512-abc'));
    const b = await importModule(fileUrl('agent-b/pkg/index.js', 'sha512-abc'));

    expect(inner).toHaveBeenCalledTimes(1);
    expect(a).toBe(module);
    expect(b).toBe(module);
    expect(b).toBe(a);
  });

  it('imports separately when integrity values differ', async () => {
    const inner = mock(async (url: string) => ({ url }));
    const importModule = createMemoizingImportModule(inner);

    const a = await importModule(fileUrl('agent-a/pkg/index.js', 'sha512-abc'));
    const b = await importModule(fileUrl('agent-a/pkg/index.js', 'sha512-xyz'));

    expect(inner).toHaveBeenCalledTimes(2);
    expect(a).not.toBe(b);
  });

  it('does not memoize a URL with no integrity param', async () => {
    const inner = mock(async (url: string) => ({ url }));
    const importModule = createMemoizingImportModule(inner);

    const url = fileUrl('agent-a/pkg/index.js');
    const a = await importModule(url);
    const b = await importModule(url);

    expect(inner).toHaveBeenCalledTimes(2);
    expect(a).not.toBe(b);
  });

  it('dedups concurrent first-callers onto a single underlying import', async () => {
    let resolveImport: (value: { tool: string }) => void = () => {};
    const module = { tool: 'shared' };
    const inner = mock(
      () =>
        new Promise<{ tool: string }>((resolve) => {
          resolveImport = resolve;
        })
    );
    const importModule = createMemoizingImportModule(inner);

    const first = importModule(fileUrl('agent-a/pkg/index.js', 'sha512-abc'));
    const second = importModule(fileUrl('agent-b/pkg/index.js', 'sha512-abc'));

    expect(inner).toHaveBeenCalledTimes(1);

    resolveImport(module);
    const [a, b] = await Promise.all([first, second]);
    expect(a).toBe(module);
    expect(b).toBe(module);
  });
});
