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

  it('describes runtime discovery and delegation to specialist agents', () => {
    const prompt = buildPersonalAgentSystemPrompt('Myra', xmlFormat);
    expect(prompt).toContain('discover them at runtime');
    expect(prompt).toContain('delegate');
  });

  it('includes a dedicated delegation section', () => {
    const prompt = buildPersonalAgentSystemPrompt('Myra', xmlFormat);
    expect(prompt).toContain('<delegation>');
  });

  it('documents the direct tools: files, web search, artifacts, directory, and messaging', () => {
    const prompt = buildPersonalAgentSystemPrompt('Myra', xmlFormat);
    expect(prompt).toContain('<tools>');
    expect(prompt).toContain('write_file');
    expect(prompt).toContain('exa_search');
    expect(prompt).toContain('artifact_create');
    expect(prompt).toContain('list_agents');
    expect(prompt).toContain('mail_send');
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

  // Never broadcast the same question to multiple agents
  it('forbids broadcasting the same question to multiple agents', () => {
    const prompt = buildPersonalAgentSystemPrompt('Myra', xmlFormat);
    expect(prompt).toContain('Never send the same question to multiple agents');
  });

  // Route by each agent's described purpose
  it('directs the agent to route by each specialist’s described purpose', () => {
    const prompt = buildPersonalAgentSystemPrompt('Myra', xmlFormat);
    expect(prompt).toContain('description');
    expect(prompt).toContain('the one specialist whose purpose fits');
  });

  // Source priority: agents first, then own notes, artifacts for shared work
  it('orders information sources: ask agents first, then own notes, then artifacts', () => {
    const prompt = buildPersonalAgentSystemPrompt('Myra', xmlFormat);
    expect(prompt).toContain('<sources>');
    expect(prompt.toLowerCase()).toContain('ask the right specialist');
  });

  // Temporal/recency requests fetch fresh, never a stale artifact
  it('requires fresh data from the owning agent for time-bound requests', () => {
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

  // CL-1784 — mail query arguments are objects, not JSON strings
  it('warns that mail query arguments are objects, not JSON strings', () => {
    const prompt = buildPersonalAgentSystemPrompt('Myra', xmlFormat);
    expect(prompt).toContain('as a JSON object, not a string');
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

  // CL-1789 — mail_wait removed; async delegation pattern
  it('does not instruct Myra to call mail_wait', () => {
    const prompt = buildPersonalAgentSystemPrompt('Myra', xmlFormat);
    expect(prompt).not.toContain('mail_wait');
  });

  it('instructs Myra to end her turn after sending and inform the user she is waiting', () => {
    const prompt = buildPersonalAgentSystemPrompt('Myra', xmlFormat);
    expect(prompt).toContain('end your turn');
    expect(prompt).toContain('waiting on the reply');
  });

  it('instructs Myra to record pending delegations in her notes before ending the turn', () => {
    const prompt = buildPersonalAgentSystemPrompt('Myra', xmlFormat);
    expect(prompt).toContain('PENDING.md');
  });

  it('instructs Myra to check for inbound agent replies at the start of a new turn', () => {
    const prompt = buildPersonalAgentSystemPrompt('Myra', xmlFormat);
    expect(prompt).toContain(
      'When a new inbound message arrives that is not from the person you work for'
    );
    expect(prompt).toContain('PENDING.md');
    expect(prompt).toContain('mail_search');
  });

  it('provides a fallback when mail_search finds no pending match', () => {
    const prompt = buildPersonalAgentSystemPrompt('Myra', xmlFormat);
    expect(prompt).toContain('no matching pending delegation');
  });

  it('instructs Myra to surface stale pending delegations to the user', () => {
    const prompt = buildPersonalAgentSystemPrompt('Myra', xmlFormat);
    expect(prompt).toContain('older than');
    expect(prompt).toContain('unresolved');
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
});
