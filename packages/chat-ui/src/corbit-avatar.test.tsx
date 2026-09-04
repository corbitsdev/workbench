import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import {
  CorbitAvatar,
  CORBIT_DEFAULT_BACKGROUND,
  CORBIT_GLINT_COLOR,
  CORBIT_VISOR_COLOR,
} from "./corbit-avatar";

describe("CorbitAvatar", () => {
  test("renders an SVG avatar with role img and accessible label", () => {
    const html = renderToStaticMarkup(<CorbitAvatar label="Myra" size="md" />);
    expect(html).toContain('role="img"');
    expect(html).toContain('aria-label="Myra"');
    expect(html).toContain('data-corbit="true"');
    expect(html).toContain("<svg");
    expect(html).toContain('viewBox="0 0 100 100"');
  });

  test("uses default Summit Blue background and allows custom pastel background", () => {
    const defaultHtml = renderToStaticMarkup(<CorbitAvatar label="Myra" />);
    expect(defaultHtml).toContain(`fill="${CORBIT_DEFAULT_BACKGROUND}"`);

    const customHtml = renderToStaticMarkup(
      <CorbitAvatar label="Myra" background="#C1D1BE" />,
    );
    expect(customHtml).toContain('fill="#C1D1BE"');
  });

  test("contains the distinct visor and sensor glint geometries", () => {
    const html = renderToStaticMarkup(<CorbitAvatar label="Myra" />);
    expect(html).toContain(`fill="${CORBIT_VISOR_COLOR}"`);
    expect(html).toContain(`fill="${CORBIT_GLINT_COLOR}"`);
  });

  test("supports size tokens and numeric dimensions", () => {
    const smHtml = renderToStaticMarkup(
      <CorbitAvatar label="Agent" size="sm" />,
    );
    expect(smHtml).toContain("size-6");

    const lgHtml = renderToStaticMarkup(
      <CorbitAvatar label="Agent" size="lg" />,
    );
    expect(lgHtml).toContain("size-10");

    const customSizeHtml = renderToStaticMarkup(
      <CorbitAvatar label="Agent" size={28} />,
    );
    expect(customSizeHtml).toContain("width:28px");
    expect(customSizeHtml).toContain("height:28px");
  });

  test("renders optional tenant monogram badge when provided", () => {
    const html = renderToStaticMarkup(
      <CorbitAvatar label="Myra" tenantMonogram="A" />,
    );
    expect(html).toContain("A");
  });
});
