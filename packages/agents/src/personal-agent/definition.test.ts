/// <reference types="bun" />
import { describe, expect, it } from 'bun:test';
import { PERSONAL_AGENT_BASE_TOOLS, PERSONAL_AGENT_DEPLOY_PROMPT } from './definition';

describe('PERSONAL_AGENT_BASE_TOOLS (CL-1555)', () => {
  it('includes artifact_create', () => {
    expect(PERSONAL_AGENT_BASE_TOOLS).toContain('artifact_create');
  });

  it('includes artifact_read', () => {
    expect(PERSONAL_AGENT_BASE_TOOLS).toContain('artifact_read');
  });

  it('includes artifact_write', () => {
    expect(PERSONAL_AGENT_BASE_TOOLS).toContain('artifact_write');
  });

  it('includes artifact_list', () => {
    expect(PERSONAL_AGENT_BASE_TOOLS).toContain('artifact_list');
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
