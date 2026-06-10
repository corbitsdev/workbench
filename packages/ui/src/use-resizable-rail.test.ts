import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type * as React from 'react';
import { act, renderHook } from '@testing-library/react';
import { useResizableRail } from './use-resizable-rail';

const STORAGE_KEY = 'cw-rail';
const MIN = 248;
const MAX = 620;
const DEFAULT_WIDTH = 340;

function attachContainer(
  result: { current: ReturnType<typeof useResizableRail> },
  options: { left?: number; clientWidth?: number } = {}
): HTMLDivElement {
  const el = document.createElement('div');
  Object.defineProperty(el, 'clientWidth', {
    configurable: true,
    value: options.clientWidth ?? 5000,
  });
  el.getBoundingClientRect = () =>
    ({ left: options.left ?? 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }) as DOMRect;
  // The hook owns the ref; assign so subsequent setRail calls read the container.
  (result.current.containerRef as { current: HTMLDivElement | null }).current = el;
  return el;
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  localStorage.clear();
});

describe('useResizableRail initial width', () => {
  it('defaults to DEFAULT_WIDTH with no stored value', () => {
    const { result } = renderHook(() => useResizableRail());
    expect(result.current.width).toBe(DEFAULT_WIDTH);
    expect(result.current.min).toBe(MIN);
  });

  it('reads and clamps a stored width above MAX', () => {
    localStorage.setItem(STORAGE_KEY, '9999');
    const { result } = renderHook(() => useResizableRail());
    expect(result.current.width).toBe(MAX);
  });

  it('ignores a non-numeric stored value', () => {
    localStorage.setItem(STORAGE_KEY, 'abc');
    const { result } = renderHook(() => useResizableRail());
    expect(result.current.width).toBe(DEFAULT_WIDTH);
  });
});

describe('useResizableRail keyboard nudging', () => {
  it('shrinks on ArrowLeft and grows on ArrowRight, clamped to MIN', () => {
    const { result } = renderHook(() => useResizableRail());
    attachContainer(result);
    let prevented = 0;
    const ev = (key: string) =>
      ({ key, preventDefault: () => (prevented += 1) }) as unknown as React.KeyboardEvent;

    act(() => result.current.handleProps.onKeyDown(ev('ArrowRight')));
    expect(result.current.width).toBe(DEFAULT_WIDTH + 24);

    act(() => result.current.handleProps.onKeyDown(ev('ArrowLeft')));
    expect(result.current.width).toBe(DEFAULT_WIDTH);
    expect(prevented).toBe(2);
  });

  it('ignores unrelated keys', () => {
    const { result } = renderHook(() => useResizableRail());
    attachContainer(result);
    act(() =>
      result.current.handleProps.onKeyDown({
        key: 'Enter',
        preventDefault: () => {
          throw new Error('should not prevent default');
        },
      } as unknown as React.KeyboardEvent)
    );
    expect(result.current.width).toBe(DEFAULT_WIDTH);
  });
});

describe('useResizableRail double-click reset', () => {
  it('resets to DEFAULT_WIDTH and persists', () => {
    const { result } = renderHook(() => useResizableRail());
    attachContainer(result);
    act(() =>
      result.current.handleProps.onKeyDown({
        key: 'ArrowRight',
        preventDefault: () => {},
      } as unknown as React.KeyboardEvent)
    );
    act(() => result.current.handleProps.onDoubleClick());
    expect(result.current.width).toBe(DEFAULT_WIDTH);
    expect(localStorage.getItem(STORAGE_KEY)).toBe(String(DEFAULT_WIDTH));
  });
});

describe('useResizableRail pointer drag', () => {
  it('tracks pointer movement and clamps against the dynamic max', () => {
    const { result } = renderHook(() => useResizableRail());
    // Small container forces dynamicMax = clientWidth - GALLERY_RESERVE.
    attachContainer(result, { left: 100, clientWidth: 700 });

    act(() => result.current.handleProps.onPointerDown({} as unknown as React.PointerEvent));
    expect(result.current.dragging).toBe(true);

    act(() => {
      window.dispatchEvent(Object.assign(new Event('pointermove'), { clientX: 100 + 400 }));
    });
    // dynamicMax = 700 - 360 = 340, so 400 clamps to 340.
    expect(result.current.width).toBe(340);
    expect(result.current.max).toBe(340);

    act(() => {
      window.dispatchEvent(new Event('pointerup'));
    });
    expect(result.current.dragging).toBe(false);
  });

  it('clamps a small drag target up to MIN', () => {
    const { result } = renderHook(() => useResizableRail());
    attachContainer(result, { left: 0, clientWidth: 5000 });
    act(() => result.current.handleProps.onPointerDown({} as unknown as React.PointerEvent));
    act(() => {
      window.dispatchEvent(Object.assign(new Event('pointermove'), { clientX: 10 }));
    });
    expect(result.current.width).toBe(MIN);
  });

  it('ignores pointer events when not dragging', () => {
    const { result } = renderHook(() => useResizableRail());
    const widthBefore = result.current.width;
    act(() => {
      window.dispatchEvent(Object.assign(new Event('pointermove'), { clientX: 999 }));
      window.dispatchEvent(new Event('pointerup'));
    });
    expect(result.current.width).toBe(widthBefore);
    expect(result.current.dragging).toBe(false);
  });

  it('tears down its window listeners on unmount', () => {
    const { result, unmount } = renderHook(() => useResizableRail());
    attachContainer(result, { left: 0, clientWidth: 5000 });
    act(() => result.current.handleProps.onPointerDown({} as unknown as React.PointerEvent));
    const widthBeforeUnmount = result.current.width;
    unmount();
    // After cleanup the listeners are gone; a stray pointermove is inert.
    act(() => {
      window.dispatchEvent(Object.assign(new Event('pointermove'), { clientX: 4000 }));
    });
    expect(result.current.width).toBe(widthBeforeUnmount);
  });
});

describe('useResizableRail window resize re-clamp', () => {
  it('re-clamps the stored width when the viewport resizes', () => {
    localStorage.setItem(STORAGE_KEY, '600');
    const { result } = renderHook(() => useResizableRail());
    attachContainer(result, { clientWidth: 700 });
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });
    // dynamicMax = 700 - 360 = 340.
    expect(result.current.width).toBe(340);
  });
});
