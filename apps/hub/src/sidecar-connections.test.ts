import { describe, it, expect, mock } from 'bun:test';
import { createSidecarConnectionRegistry } from './sidecar-connections';

describe('createSidecarConnectionRegistry', () => {
  it('closes every tracked connection on closeAll', () => {
    const registry = createSidecarConnectionRegistry();
    const a = { close: mock(() => {}) };
    const b = { close: mock(() => {}) };
    registry.track(a);
    registry.track(b);

    registry.closeAll();

    expect(a.close).toHaveBeenCalledTimes(1);
    expect(b.close).toHaveBeenCalledTimes(1);
    expect(registry.size()).toBe(0);
  });

  it('does not close an untracked connection', () => {
    const registry = createSidecarConnectionRegistry();
    const a = { close: mock(() => {}) };
    registry.track(a);
    registry.untrack(a);

    registry.closeAll();

    expect(a.close).not.toHaveBeenCalled();
  });

  it('continues closing remaining connections when one throws', () => {
    const registry = createSidecarConnectionRegistry();
    const bad = {
      close: mock(() => {
        throw new Error('socket already closing');
      }),
    };
    const good = { close: mock(() => {}) };
    registry.track(bad);
    registry.track(good);

    expect(() => registry.closeAll()).not.toThrow();
    expect(good.close).toHaveBeenCalledTimes(1);
  });
});
