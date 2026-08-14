// The progress rail must never claim a step is required when the wizard
// itself lets you skip it — "Connect your tools" always advances whether
// or not anything got connected, so both the label and the rail segment
// for that step say so honestly.

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { OnboardingProgress } from "./onboarding-progress";

describe("OnboardingProgress", () => {
  test("marks the optional step's label", () => {
    const markup = renderToStaticMarkup(
      <OnboardingProgress
        step={3}
        totalSteps={4}
        label="Connect your tools"
        optionalStep={3}
      />,
    );
    expect(markup).toContain("Connect your tools · optional");
  });

  test("does not mark a required step's label as optional", () => {
    const markup = renderToStaticMarkup(
      <OnboardingProgress
        step={1}
        totalSteps={4}
        label="Name your workbench"
        optionalStep={3}
      />,
    );
    const labelText = markup.match(/onboarding-progress-label">([^<]*)</)?.[1];
    expect(labelText).not.toContain("optional");
  });

  test("flags the optional step's rail segment regardless of the current step", () => {
    const markup = renderToStaticMarkup(
      <OnboardingProgress
        step={1}
        totalSteps={4}
        label="Name your workbench"
        optionalStep={3}
      />,
    );
    const segments = markup.match(
      /<span[^>]*class="onboarding-progress-segment"[^>]*>/g,
    );
    expect(segments).not.toBeNull();
    expect(segments?.[2]).toContain('data-optional="true"');
    expect(segments?.[0]).not.toContain("data-optional");
  });
});
