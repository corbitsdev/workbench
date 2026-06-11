import { describe, it, expect } from 'bun:test';
import { resolveSidecarHeartbeat } from './config';

describe('resolveSidecarHeartbeat', () => {
  it('uses fast defaults when env is unset', () => {
    const hb = resolveSidecarHeartbeat({});
    expect(hb.pingIntervalMs).toBe(5_000);
    expect(hb.reconnectDelayMs).toBe(1_000);
  });

  it('overrides from env when provided', () => {
    const hb = resolveSidecarHeartbeat({
      SIDECAR_PING_INTERVAL_MS: '2000',
      SIDECAR_RECONNECT_DELAY_MS: '500',
    });
    expect(hb.pingIntervalMs).toBe(2_000);
    expect(hb.reconnectDelayMs).toBe(500);
  });

  it('rejects a non-integer override', () => {
    expect(() => resolveSidecarHeartbeat({ SIDECAR_PING_INTERVAL_MS: 'soon' })).toThrow(
      'SIDECAR_PING_INTERVAL_MS must be a positive integer (got "soon")'
    );
  });

  it('rejects a non-positive override', () => {
    expect(() => resolveSidecarHeartbeat({ SIDECAR_RECONNECT_DELAY_MS: '0' })).toThrow(
      'SIDECAR_RECONNECT_DELAY_MS must be a positive integer (got "0")'
    );
  });
});
