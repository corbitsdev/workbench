import { describe, it, expect } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildDeployRequest,
  readWorkflowMeta,
  readWorkflowVersion,
  resolveDeployAuth,
  resolveGitSha,
  resolveWorkflowEntry,
} from './deploy-workflow';

describe('resolveDeployAuth', () => {
  it('prefers SESSION_TOKEN (operator session path)', () => {
    const auth = resolveDeployAuth({
      SESSION_TOKEN: 'sess',
      SIDECAR_TOKEN: 'svc',
    } as NodeJS.ProcessEnv);
    expect(auth).toEqual({ mode: 'session', sessionToken: 'sess' });
  });

  it('falls back to SIDECAR_TOKEN when no session is present', () => {
    const auth = resolveDeployAuth({
      SIDECAR_TOKEN: 'svc',
    } as NodeJS.ProcessEnv);
    expect(auth).toEqual({ mode: 'service', serviceToken: 'svc' });
  });

  it('accepts HUB_SERVICE_TOKEN as a legacy alias for the service token', () => {
    const auth = resolveDeployAuth({
      HUB_SERVICE_TOKEN: 'legacy',
    } as NodeJS.ProcessEnv);
    expect(auth).toEqual({ mode: 'service', serviceToken: 'legacy' });
  });

  it('throws when no credential is available', () => {
    expect(() => resolveDeployAuth({} as NodeJS.ProcessEnv)).toThrow(/no credential found/);
  });
});

describe('resolveWorkflowEntry', () => {
  it('resolves a real workflow kind to its on-disk entry file', () => {
    const entry = resolveWorkflowEntry('pain-point-collateral');
    expect(entry).toMatch(/workflows\/pain-point-collateral\/src\/index\.ts$/);
  });

  it('throws for a kind with no workflow package', () => {
    expect(() => resolveWorkflowEntry('does-not-exist')).toThrow(
      /no workflow package at workflows\/does-not-exist/
    );
  });
});

describe('readWorkflowMeta', () => {
  it('returns version from the workflow package.json for a known kind', () => {
    const meta = readWorkflowMeta('pain-point-collateral');
    expect(meta.version).toBe('0.1.0');
    expect(typeof meta.sha).toBe('string');
    expect(meta.sha.length).toBeGreaterThan(0);
    expect(meta.deployedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('populates sha and deployedAt for a known kind', () => {
    const meta = readWorkflowMeta('pain-point-collateral');
    expect(typeof meta.sha).toBe('string');
    expect(meta.sha.length).toBeGreaterThan(0);
    expect(meta.deployedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe('readWorkflowVersion', () => {
  it('reads the version field from a real package.json', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wf-meta-'));
    try {
      const manifest = join(dir, 'package.json');
      writeFileSync(manifest, JSON.stringify({ version: '2.3.4' }), 'utf8');
      expect(readWorkflowVersion(manifest)).toBe('2.3.4');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('defaults to 0.0.0 when the manifest is absent', () => {
    expect(readWorkflowVersion(join(tmpdir(), 'definitely-missing-pkg.json'))).toBe('0.0.0');
  });

  it('defaults to 0.0.0 when the manifest has no version field', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wf-meta-'));
    try {
      const manifest = join(dir, 'package.json');
      writeFileSync(manifest, JSON.stringify({ name: 'no-version' }), 'utf8');
      expect(readWorkflowVersion(manifest)).toBe('0.0.0');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('defaults to 0.0.0 when the manifest is unparseable JSON', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wf-meta-'));
    try {
      const manifest = join(dir, 'package.json');
      writeFileSync(manifest, '{ not valid json', 'utf8');
      expect(readWorkflowVersion(manifest)).toBe('0.0.0');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('resolveGitSha', () => {
  it('returns the trimmed short sha when git succeeds', () => {
    expect(resolveGitSha(() => ({ status: 0, stdout: 'abc1234\n' }))).toBe('abc1234');
  });

  it('returns unknown when git exits non-zero', () => {
    expect(resolveGitSha(() => ({ status: 128, stdout: null }))).toBe('unknown');
  });

  it('returns unknown when git produces no stdout', () => {
    expect(resolveGitSha(() => ({ status: 0, stdout: null }))).toBe('unknown');
  });

  it('returns unknown when git produces empty stdout', () => {
    expect(resolveGitSha(() => ({ status: 0, stdout: '  \n' }))).toBe('unknown');
  });
});

describe('buildDeployRequest', () => {
  it('session auth posts to /api/v1 with the better-auth cookie', () => {
    const { url, headers } = buildDeployRequest('http://hub', '?tenant=gtm', {
      mode: 'session',
      sessionToken: 'sess',
    });
    expect(url).toBe('http://hub/api/v1/workflows/deploy?tenant=gtm');
    expect(headers['Cookie']).toContain('better-auth.session_token=sess');
    expect(headers['Cookie']).toContain('__Secure-better-auth.session_token=sess');
    expect(headers['Authorization']).toBeUndefined();
  });

  it('service auth posts to /api/internal with a Bearer token', () => {
    const { url, headers } = buildDeployRequest('http://hub', '', {
      mode: 'service',
      serviceToken: 'svc',
    });
    expect(url).toBe('http://hub/api/internal/workflows/deploy');
    expect(headers['Authorization']).toBe('Bearer svc');
    expect(headers['Cookie']).toBeUndefined();
  });
});
