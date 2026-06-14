/// <reference types="bun" />
import { describe, expect, it } from 'bun:test';
import * as barrel from './index';
import * as definition from './definition';

describe('tool-agent barrel', () => {
  it('re-exports the public definition surface unchanged', () => {
    expect(barrel.AGENT_NAME).toBe(definition.AGENT_NAME);
    expect(barrel.RENAME_ME_CAPABILITIES).toBe(definition.RENAME_ME_CAPABILITIES);
    expect(barrel.RENAME_ME_CREDENTIAL_REQUIREMENTS).toBe(
      definition.RENAME_ME_CREDENTIAL_REQUIREMENTS
    );
    expect(barrel.RENAME_ME_DEPLOY_PROMPT).toBe(definition.RENAME_ME_DEPLOY_PROMPT);
  });

  it('exposes exactly the four named exports', () => {
    expect(Object.keys(barrel).sort()).toEqual([
      'AGENT_NAME',
      'RENAME_ME_CAPABILITIES',
      'RENAME_ME_CREDENTIAL_REQUIREMENTS',
      'RENAME_ME_DEPLOY_PROMPT',
    ]);
  });
});
