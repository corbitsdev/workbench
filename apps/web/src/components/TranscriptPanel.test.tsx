/// <reference types="bun" />
import { describe, expect, it } from 'bun:test';
import type { TranscriptPanelProps } from './TranscriptPanel';

describe('TranscriptPanel types', () => {
  it('accepts transcript as required string prop', () => {
    const props: TranscriptPanelProps = { transcript: 'Sample text' };
    expect(props.transcript).toBe('Sample text');
  });

  it('accepts undefined transcript', () => {
    const props: TranscriptPanelProps = { transcript: undefined };
    expect(props.transcript).toBeUndefined();
  });

  it('allows empty string transcript', () => {
    const props: TranscriptPanelProps = { transcript: '' };
    expect(props.transcript).toBe('');
  });

  it('determines if transcript is available', () => {
    const available: TranscriptPanelProps = { transcript: 'content' };
    const unavailable: TranscriptPanelProps = { transcript: undefined };

    const isAvailable = (props: TranscriptPanelProps) =>
      props.transcript !== undefined && props.transcript.trim().length > 0;

    expect(isAvailable(available)).toBe(true);
    expect(isAvailable(unavailable)).toBe(false);
  });

  it('handles multiline transcript content', () => {
    const multiline = 'Line 1\n\nLine 2\nLine 3';
    const props: TranscriptPanelProps = { transcript: multiline };
    expect(props.transcript?.includes('\n')).toBe(true);
  });
});
