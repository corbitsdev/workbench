import { describe, expect, test } from 'bun:test';
import { AGENT_TEMPLATES } from './templates';
import { LARRY_DEPLOY_DESCRIPTOR, LARRY_TOOL_PACKAGES } from './larry/definition';

describe('tool-package pins', () => {
  test('Larry pins its native tool packages and the descriptor reuses them', () => {
    const names = LARRY_TOOL_PACKAGES.map((p) => p.name);
    expect(names).toContain('@workbench/tools-hackernews');
    expect(names).toContain('@workbench/tools-exa');
    expect(names).toContain('@workbench/tools-scrapecreators');
    expect(LARRY_TOOL_PACKAGES.every((p) => p.version === '^0.1.0')).toBe(true);
    expect(LARRY_DEPLOY_DESCRIPTOR.toolPackages).toBe(LARRY_TOOL_PACKAGES);
  });

  test('Larry template carries the pins for DB persistence at seed time', () => {
    const larry = AGENT_TEMPLATES.find((t) => t.name === 'Larry');
    expect(larry?.toolPackages).toEqual(LARRY_TOOL_PACKAGES);
  });

  test('Loop and unknown agents have no tool packages', () => {
    const loop = AGENT_TEMPLATES.find((t) => t.name === 'Loop');
    expect(loop?.toolPackages ?? []).toEqual([]);
    const unknown = AGENT_TEMPLATES.find((t) => t.name === 'does-not-exist');
    expect(unknown).toBeUndefined();
  });

  test('the hackernews pin still appears in Larry capabilities for grant coverage (prefixed)', () => {
    const larry = AGENT_TEMPLATES.find((t) => t.name === 'Larry');
    expect(larry?.capabilities.tools).toContain(
      '@workbench/tools-hackernews/hackernews:hackernews_search'
    );
  });
});
