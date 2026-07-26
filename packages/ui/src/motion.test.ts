/// <reference types="bun" />
import { describe, expect, it } from "bun:test";
import {
  EASE_CURVE,
  SPRING_EASE,
  crossfadePresence,
  motionPropsWhen,
  popupPanelMotion,
  revealUp,
  springTransition,
  staggerContainerVariants,
  staggerItemTransition,
  staggerItemVariants,
  staggerSlideIn,
} from "./motion";

describe("motion presets", () => {
  it("SPRING_EASE matches styles.css --spring control points", () => {
    expect(SPRING_EASE).toEqual([0.34, 1.56, 0.64, 1]);
  });

  it("EASE_CURVE matches styles.css --ease control points", () => {
    expect(EASE_CURVE).toEqual([0.22, 0.61, 0.36, 1]);
  });

  it("springTransition uses brand spring ease and optional delay", () => {
    const t = springTransition({ duration: 0.4, delay: 0.1 });
    expect(t.duration).toBe(0.4);
    expect(t.delay).toBe(0.1);
    expect(t.ease).toEqual(SPRING_EASE);
  });

  it("staggerItemTransition scales delay by index", () => {
    expect(staggerItemTransition(3, 0.05).delay).toBeCloseTo(0.15);
  });
});

describe("reduceMotion factories", () => {
  it("motionPropsWhen returns empty when reduced", () => {
    expect(motionPropsWhen(true, revealUp)).toEqual({});
  });

  it("motionPropsWhen returns props when motion allowed", () => {
    expect(motionPropsWhen(false, revealUp)).toEqual(revealUp);
  });

  it("popupPanelMotion strips enter/exit when reduced", () => {
    const full = popupPanelMotion(false);
    expect(full.initial).toBeDefined();
    expect(full.exit).toBeDefined();
    expect(popupPanelMotion(true)).toEqual({});
  });

  it("crossfadePresence omits motion keys when reduced", () => {
    expect(crossfadePresence(true)).toEqual({});
    expect(crossfadePresence(false).exit).toBeDefined();
  });

  it("staggerSlideIn returns plain div props when reduced", () => {
    expect(staggerSlideIn(true, 2)).toEqual({});
    const animated = staggerSlideIn(false, 2);
    expect(animated.initial).toBeDefined();
    expect(animated.transition?.delay).toBe(0.2);
  });
});

describe("stagger variants", () => {
  it("container coordinates staggerChildren", () => {
    const show = staggerContainerVariants.show;
    expect(show).toBeDefined();
    if (show && typeof show === "object" && "transition" in show) {
      const tr = show.transition as { staggerChildren?: number };
      expect(tr.staggerChildren).toBe(0.05);
    }
  });

  it("item hidden state offsets upward", () => {
    expect(staggerItemVariants.hidden).toEqual({ opacity: 0, y: 8 });
  });
});
