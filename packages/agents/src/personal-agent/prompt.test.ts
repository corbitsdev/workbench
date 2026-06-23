import { describe, expect, it } from 'bun:test';
import { buildPersonalAgentSystemPrompt } from './prompt';

const xmlFormat = { xml: true };
const markdownFormat = { xml: false };

describe('buildPersonalAgentSystemPrompt', () => {
  it('frames the named agent as a Chief of Staff for one person', () => {
    const prompt = buildPersonalAgentSystemPrompt('Myra', xmlFormat);
    expect(prompt).toContain('Myra is a Chief of Staff and Executive Assistant');
    expect(prompt).toContain('single person');
  });

  it('interpolates whatever name is supplied', () => {
    const prompt = buildPersonalAgentSystemPrompt('Assistant', xmlFormat);
    expect(prompt).toContain('Assistant is a Chief of Staff');
  });

  it('includes the role, capabilities, and guidelines sections', () => {
    const prompt = buildPersonalAgentSystemPrompt('Myra', xmlFormat);
    expect(prompt).toContain('<role>');
    expect(prompt).toContain('<capabilities>');
    expect(prompt).toContain('<guidelines>');
  });

  it('documents the direct tools: files, web search, artifacts, directory, and domain tools', () => {
    const prompt = buildPersonalAgentSystemPrompt('Myra', xmlFormat);
    expect(prompt).toContain('<tools>');
    expect(prompt).toContain('write_file');
    expect(prompt).toContain('exa_search');
    expect(prompt).toContain('artifact_create');
    expect(prompt).toContain('list_agents');
    expect(prompt).toContain('granola_list_notes');
    expect(prompt).toContain('linear_list_issues');
    expect(prompt).toContain('attio_query_records');
  });

  it('no longer advertises mail tools or a delegation section', () => {
    const prompt = buildPersonalAgentSystemPrompt('Myra', xmlFormat);
    expect(prompt).not.toContain('mail_send');
    expect(prompt).not.toContain('<delegation>');
    expect(prompt).not.toContain('PENDING.md');
  });

  it('coordinates expertise rather than claiming authority', () => {
    const prompt = buildPersonalAgentSystemPrompt('Myra', xmlFormat);
    expect(prompt).toContain('coordinate expertise');
  });

  it('directs the agent to confirm before irreversible or high-stakes actions', () => {
    const prompt = buildPersonalAgentSystemPrompt('Myra', xmlFormat);
    expect(prompt.toLowerCase()).toContain('irreversible');
  });

  it('forbids fabrication and impersonation of the person served', () => {
    const prompt = buildPersonalAgentSystemPrompt('Myra', xmlFormat);
    expect(prompt).toContain('Never fabricate information');
    expect(prompt).toContain('Never impersonate the person you work for');
  });

  it('carries a concise style note rather than the full humanizer essay', () => {
    const prompt = buildPersonalAgentSystemPrompt('Myra', xmlFormat);
    expect(prompt).toContain('No emojis unless explicitly requested');
    expect(prompt).not.toContain('superficial -ing analyses');
    expect(prompt).not.toContain('negative parallelisms');
  });

  it('respects the requested output format', () => {
    expect(buildPersonalAgentSystemPrompt('Myra', xmlFormat)).toContain('<role>');
    expect(buildPersonalAgentSystemPrompt('Myra', markdownFormat)).toContain('## Role');
  });

  // Effort calibration — no tool-spam on a greeting
  it('calibrates effort so greetings get a direct reply without tool use', () => {
    const prompt = buildPersonalAgentSystemPrompt('Myra', xmlFormat).toLowerCase();
    expect(prompt).toContain('match your effort to the request');
    expect(prompt).toContain('greeting');
    expect(prompt).toContain('without running tools');
  });

  // Voice — operator framing stays internal
  it('keeps the operator framing internal — no reciting a title or calling them "operator"', () => {
    const prompt = buildPersonalAgentSystemPrompt('Myra', xmlFormat);
    expect(prompt).toContain('do not announce your title');
    expect(prompt).toContain('Never call the person you work for "your operator" out loud');
  });

  // Source priority: domain tools first, then own notes, then artifacts
  it('orders information sources: domain tools first, then own notes, then artifacts', () => {
    const prompt = buildPersonalAgentSystemPrompt('Myra', xmlFormat);
    expect(prompt).toContain('<sources>');
    expect(prompt).toContain('The right tool for the domain');
  });

  // Temporal/recency requests fetch fresh, never a stale artifact
  it('requires fresh data from the owning tool for time-bound requests', () => {
    const prompt = buildPersonalAgentSystemPrompt('Myra', xmlFormat);
    expect(prompt.toLowerCase()).toContain('my last call');
    expect(prompt).toContain('Do not answer it from an artifact');
  });

  // Self-notes convention
  it('documents the self-notes files Myra maintains', () => {
    const prompt = buildPersonalAgentSystemPrompt('Myra', xmlFormat);
    expect(prompt).toContain('<notes>');
    for (const file of ['MEMORY.md', 'SCRATCHPAD.md', 'CONTACTS.md', 'ERRORS.md', 'HUMAN.md']) {
      expect(prompt).toContain(file);
    }
  });

  // Per-operator appendix
  it('appends an operator section only when a profile is supplied', () => {
    const base = buildPersonalAgentSystemPrompt('Myra', xmlFormat);
    expect(base).not.toContain('<operator>');

    const withProfile = buildPersonalAgentSystemPrompt('Myra', xmlFormat, {
      operatorProfile: 'You work for Sawyer Cutler, lead product engineer at Corbits.',
    });
    expect(withProfile).toContain('<operator>');
    expect(withProfile).toContain('Sawyer Cutler');
  });

  it('renders the operator section heading in markdown when xml is off', () => {
    const withProfile = buildPersonalAgentSystemPrompt('Myra', markdownFormat, {
      operatorProfile: 'You work for Sawyer.',
    });
    expect(withProfile).toContain('## Operator');
  });

  it('ignores a blank operator profile', () => {
    const prompt = buildPersonalAgentSystemPrompt('Myra', xmlFormat, {
      operatorProfile: '   ',
    });
    expect(prompt).not.toContain('<operator>');
  });

  // CL-1951 — a referenced artifact id should be loaded via artifact_read, not asked about
  it('directs Myra to load a referenced artifact id with artifact_read', () => {
    const prompt = buildPersonalAgentSystemPrompt('Myra', xmlFormat).toLowerCase();
    expect(prompt).toContain('artifact_read');
    expect(prompt).toContain('that artifact is the subject of the request');
  });

  it('keeps the artifact_read nudge consistent with the <sources> recency rules', () => {
    const prompt = buildPersonalAgentSystemPrompt('Myra', xmlFormat).toLowerCase();
    expect(prompt).toContain('<sources> recency rules still govern');
    expect(prompt).toContain('do not answer it from an artifact');
  });

  // CL-1952 — the base prompt carries the memory-seed marker so the sidecar can
  // parse the file list out of the effective (personalized) prompt.
  it('embeds the memory-seed marker in the base prompt regardless of format', () => {
    expect(buildPersonalAgentSystemPrompt('Myra', xmlFormat)).toContain(
      '<!-- workbench:memory-seed='
    );
    expect(buildPersonalAgentSystemPrompt('Myra', markdownFormat)).toContain(
      '<!-- workbench:memory-seed='
    );
  });
});
