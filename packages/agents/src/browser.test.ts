import { describe, expect, it } from 'bun:test';
import { PREMADE_AGENTS, WALTER_DEPLOY_DESCRIPTOR } from './browser';

describe('browser premade agents', () => {
  it('includes Walter as a writer premade', () => {
    expect(PREMADE_AGENTS).toContain(WALTER_DEPLOY_DESCRIPTOR);
    expect(WALTER_DEPLOY_DESCRIPTOR).toMatchObject({
      label: 'Walter - Writer',
      name: 'Walter',
      credentialProviderNames: ['openai-compatible'],
      defaultTools: [
        'read_file',
        'write_file',
        'edit_file',
        'search_files',
        'artifact_link_file',
        'mail_reply',
      ],
      requiredTools: [
        'read_file',
        'write_file',
        'edit_file',
        'search_files',
        'artifact_link_file',
        'mail_reply',
      ],
    });
    expect(WALTER_DEPLOY_DESCRIPTOR.systemPrompt).toContain('traditional written artifacts');
  });
});
