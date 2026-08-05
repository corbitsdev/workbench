// The dithered auth panel, tested at our wiring. This suite runs in bun's
// bare test environment (no DOM, no @testing-library), so it asserts the
// server-rendered markup: effects never run, which is exactly the no-JS
// contract the panel is built around — the canvas must be inert decoration
// and the hero <img> must already be painted underneath it. The animation
// loop itself (rAF scheduling, offscreen pause, reduced-motion) lives inside
// a browser-only effect and is exercised by the browser, not here.

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { AuthLayout } from "../src/auth/auth-layout";
import { DitherBackground } from "../src/auth/dither-background";
import { QuoteCard } from "../src/auth/quote-card";

describe("DitherBackground", () => {
  test("renders a decorative canvas, hidden from assistive tech", () => {
    const markup = renderToStaticMarkup(<DitherBackground />);
    expect(markup).toContain("<canvas");
    expect(markup).toContain('aria-hidden="true"');
  });

  test("upscales with pixelated rendering so the dither cells stay crisp", () => {
    const markup = renderToStaticMarkup(<DitherBackground />);
    expect(markup).toContain("image-rendering:pixelated");
  });

  test("passes the caller's class through to the canvas", () => {
    const markup = renderToStaticMarkup(
      <DitherBackground className="auth-panel-dither" />,
    );
    expect(markup).toContain('class="auth-panel-dither"');
  });
});

describe("the auth brand panel", () => {
  test("paints the hero image under the canvas as the no-JS fallback", () => {
    const markup = renderToStaticMarkup(<AuthLayout>form</AuthLayout>);
    const imgAt = markup.indexOf("/images/hero-dither.png");
    const canvasAt = markup.indexOf("<canvas");
    expect(imgAt).toBeGreaterThan(-1);
    expect(canvasAt).toBeGreaterThan(imgAt);
  });

  test("the panel is decoration; the form column is the main content", () => {
    const markup = renderToStaticMarkup(<AuthLayout>form</AuthLayout>);
    expect(markup).toContain("<main");
    expect(markup).toContain('class="auth-panel"');
    expect(markup).toContain("Workbench");
    expect(markup).toContain("<blockquote");
  });
});

describe("QuoteCard", () => {
  test("renders a quote without localStorage (server render has none)", () => {
    const markup = renderToStaticMarkup(<QuoteCard />);
    expect(markup).toContain("<blockquote");
    expect(markup).toContain("“");
  });
});
