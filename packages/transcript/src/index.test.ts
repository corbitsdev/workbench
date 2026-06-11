/// <reference types="bun" />
import { describe, expect, it } from 'bun:test';
import * as transcript from './index';

describe('@workbench/transcript barrel', () => {
  it('re-exports both transcript components', () => {
    expect(typeof transcript.TranscriptPanel).toBe('function');
    expect(typeof transcript.TranscriptReview).toBe('function');
  });
});
