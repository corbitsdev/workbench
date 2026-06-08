import { describe, expect, it } from 'bun:test';
import { buildToolDefinitions, KNOWN_TOOL_SUMMARIES } from './tool-registry';

describe('tool registry', () => {
  it('builds Interchange-owned POSIX tool definitions and the artifact link tool', () => {
    const definitions = buildToolDefinitions([
      'read_file',
      'write_file',
      'edit_file',
      'search_files',
      'artifact_link_file',
    ]);

    expect(definitions.map((definition) => definition.name)).toEqual([
      'read_file',
      'write_file',
      'edit_file',
      'search_files',
      'artifact_link_file',
    ]);
  });

  it('lists artifact_link_file as a Workbench tool', () => {
    expect(KNOWN_TOOL_SUMMARIES).toContainEqual(
      expect.objectContaining({ name: 'artifact_link_file', providerName: 'workbench' })
    );
  });
});
