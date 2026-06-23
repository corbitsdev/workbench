/// <reference types="bun" />
import { describe, expect, it } from 'bun:test';
import { PERSONAL_AGENT_BASE_TOOLS, PERSONAL_AGENT_DEPLOY_PROMPT } from './definition';

describe('PERSONAL_AGENT_BASE_TOOLS (CL-1555, CL-2145)', () => {
  // Artifact tools are native packages, so capabilities carry the canonical
  // prefixed runtime name the loader emits — that is what the seeded grant must
  // match (CL-2145).
  it('includes artifact_create (prefixed)', () => {
    expect(PERSONAL_AGENT_BASE_TOOLS).toContain(
      '@workbench/tools-artifact/artifact:artifact_create'
    );
  });

  it('includes artifact_read (prefixed)', () => {
    expect(PERSONAL_AGENT_BASE_TOOLS).toContain('@workbench/tools-artifact/artifact:artifact_read');
  });

  it('includes artifact_write (prefixed)', () => {
    expect(PERSONAL_AGENT_BASE_TOOLS).toContain(
      '@workbench/tools-artifact/artifact:artifact_write'
    );
  });

  it('includes artifact_list (prefixed)', () => {
    expect(PERSONAL_AGENT_BASE_TOOLS).toContain('@workbench/tools-artifact/artifact:artifact_list');
  });

  it('leaves local runner tools (posix) unprefixed', () => {
    expect(PERSONAL_AGENT_BASE_TOOLS).toContain('read_file');
    expect(PERSONAL_AGENT_BASE_TOOLS).not.toContain('mail_send');
    expect(PERSONAL_AGENT_BASE_TOOLS).not.toContain('mail_reply');
    expect(PERSONAL_AGENT_BASE_TOOLS).not.toContain('mail_search');
    expect(PERSONAL_AGENT_BASE_TOOLS).not.toContain('mail_read');
  });
});

describe('PERSONAL_AGENT_DEPLOY_PROMPT (CL-1555)', () => {
  it('mentions artifact_create in the prompt', () => {
    expect(PERSONAL_AGENT_DEPLOY_PROMPT).toContain('artifact_create');
  });

  it('mentions artifact_read in the prompt', () => {
    expect(PERSONAL_AGENT_DEPLOY_PROMPT).toContain('artifact_read');
  });
});
