/// <reference types="bun" />
import { describe, expect, it } from 'bun:test';
import type { CredentialRequirement } from '@intx/types';
import {
  AGENT_NAME,
  RENAME_ME_CAPABILITIES,
  RENAME_ME_CREDENTIAL_REQUIREMENTS,
  RENAME_ME_DEPLOY_PROMPT,
} from './definition';

type CredentialRequirementType = typeof CredentialRequirement.infer;

describe('tool-agent definition', () => {
  it('exposes the scaffold agent name', () => {
    expect(AGENT_NAME).toBe('RenameMe');
  });

  it('declares a single tenant-sourced openai-compatible credential requirement', () => {
    expect(RENAME_ME_CREDENTIAL_REQUIREMENTS).toEqual([
      { providerName: 'openai-compatible', source: 'tenant' },
    ]);
  });

  it('declares tenant-owned credentials, never principal-owned, and no name pin', () => {
    for (const requirement of RENAME_ME_CREDENTIAL_REQUIREMENTS) {
      const typed: CredentialRequirementType = requirement;
      expect(typed.source).toBe('tenant');
      expect('name' in typed).toBe(false);
    }
  });

  it('starts with no tools wired so the hub builds an empty tool list', () => {
    expect(RENAME_ME_CAPABILITIES.tools).toEqual([]);
  });

  it('exposes a non-empty deploy prompt naming the agent', () => {
    expect(RENAME_ME_DEPLOY_PROMPT.length).toBeGreaterThan(0);
    expect(RENAME_ME_DEPLOY_PROMPT).toContain('RenameMe');
  });
});
