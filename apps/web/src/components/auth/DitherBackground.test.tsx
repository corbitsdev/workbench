/// <reference types="bun" />
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import { DitherBackground } from "./DitherBackground";

// happy-dom does not implement a 2D canvas context, IntersectionObserver
// callbacks, or image loading, so the animation effect needs a small stub
// harness to actually reach its scheduling path. The stubs are restored after
// every test to avoid leaking into the rest of the suite.

type LoadHandler = ((this: unknown, ev?: unknown) => unknown) | null;

interface FakeImage {
  onload: LoadHandler;
  src: string;
  crossOrigin: string | null;
  naturalWidth: number;
  naturalHeight: number;
}

const fakeCtx = {
  createImageData: (w: number, h: number) => ({
    data: new Uint8ClampedArray(Math.max(1, w * h * 4)),
    width: w,
    height: h,
  }),
  getImageData: (_x: number, _y: number, w: number, h: number) => ({
    data: new Uint8ClampedArray(Math.max(1, w * h * 4)),
    width: w,
    height: h,
  }),
  putImageData: () => {},
  drawImage: () => {},
  clearRect: () => {},
} as unknown as CanvasRenderingContext2D;

let createdImages: FakeImage[] = [];
let rafSpy: ReturnType<typeof mock>;

const originals = {
  getContext: HTMLCanvasElement.prototype.getContext,
  Image: globalThis.Image,
  IntersectionObserver: globalThis.IntersectionObserver,
  ResizeObserver: globalThis.ResizeObserver,
  matchMedia: window.matchMedia,
  raf: globalThis.requestAnimationFrame,
  caf: globalThis.cancelAnimationFrame,
};

beforeEach(() => {
  createdImages = [];
  rafSpy = mock(() => 1);

  HTMLCanvasElement.prototype.getContext = function getContext() {
    return fakeCtx;
  } as unknown as typeof HTMLCanvasElement.prototype.getContext;

  class StubImage implements FakeImage {
    onload: LoadHandler = null;
    src = "";
    crossOrigin: string | null = null;
    naturalWidth = 16;
    naturalHeight = 16;
    constructor() {
      createdImages.push(this);
    }
  }
  globalThis.Image = StubImage as unknown as typeof Image;

  class NoopObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  globalThis.IntersectionObserver =
    NoopObserver as unknown as typeof IntersectionObserver;
  globalThis.ResizeObserver = NoopObserver as unknown as typeof ResizeObserver;

  window.matchMedia = (() => ({
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;

  globalThis.requestAnimationFrame =
    rafSpy as unknown as typeof requestAnimationFrame;
  globalThis.cancelAnimationFrame = (() => {}) as typeof cancelAnimationFrame;
});

afterEach(() => {
  cleanup();
  HTMLCanvasElement.prototype.getContext = originals.getContext;
  globalThis.Image = originals.Image;
  globalThis.IntersectionObserver = originals.IntersectionObserver;
  globalThis.ResizeObserver = originals.ResizeObserver;
  window.matchMedia = originals.matchMedia;
  globalThis.requestAnimationFrame = originals.raf;
  globalThis.cancelAnimationFrame = originals.caf;
});

describe("DitherBackground", () => {
  it("starts the animation loop once the image loads", () => {
    render(<DitherBackground />);
    const img = createdImages.at(-1);
    if (!img) throw new Error("expected the component to construct an Image");

    img.onload?.();

    expect(rafSpy).toHaveBeenCalled();
  });

  it("schedules no frame when the image loads after unmount", () => {
    const view = render(<DitherBackground />);
    const img = createdImages.at(-1);
    if (!img) throw new Error("expected the component to construct an Image");

    // Capture the in-flight handler before teardown: a real browser can fire a
    // pending load event after React has unmounted the canvas.
    const lateLoad = img.onload;
    view.unmount();
    rafSpy.mockClear();

    lateLoad?.();

    expect(rafSpy).not.toHaveBeenCalled();
  });
});
