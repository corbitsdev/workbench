import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { seedWorkspaceFiles } from './seed-workspace-files';

let workDir: string;

beforeEach(async () => {
  workDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'seed-test-'));
});

afterEach(async () => {
  await fs.promises.rm(workDir, { recursive: true, force: true });
});

describe('seedWorkspaceFiles (CL-1952)', () => {
  it('creates missing declared files with their stub content', async () => {
    const result = await seedWorkspaceFiles(workDir, [
      { path: 'MEMORY.md', content: '# Memory\n' },
    ]);

    const written = await fs.promises.readFile(path.join(workDir, 'MEMORY.md'), 'utf-8');
    expect(written).toBe('# Memory\n');
    expect(result).toEqual({ created: 1, skipped: 0 });
  });

  it('leaves an existing file untouched and reports it skipped', async () => {
    const target = path.join(workDir, 'MEMORY.md');
    await fs.promises.writeFile(target, 'accumulated memory the agent already wrote');

    const result = await seedWorkspaceFiles(workDir, [
      { path: 'MEMORY.md', content: '# Memory\n' },
    ]);

    const after = await fs.promises.readFile(target, 'utf-8');
    expect(after).toBe('accumulated memory the agent already wrote');
    expect(result).toEqual({ created: 0, skipped: 1 });
  });

  it('writes nothing when the agent declares no seed files', async () => {
    const result = await seedWorkspaceFiles(workDir, []);

    const entries = await fs.promises.readdir(workDir);
    expect(entries).toEqual([]);
    expect(result).toEqual({ created: 0, skipped: 0 });
  });

  it('rejects a traversal path and writes nothing outside the workspace', async () => {
    const escapeTarget = path.join(path.dirname(workDir), 'escaped.md');
    await fs.promises.rm(escapeTarget, { force: true });

    await expect(
      seedWorkspaceFiles(workDir, [{ path: '../escaped.md', content: 'pwned' }])
    ).rejects.toThrow('plain basename');

    expect(fs.existsSync(escapeTarget)).toBe(false);
    expect(await fs.promises.readdir(workDir)).toEqual([]);
  });
});
