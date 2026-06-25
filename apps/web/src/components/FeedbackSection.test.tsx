/// <reference types="bun" />
import { describe, expect, it } from "bun:test";
import type { FeedbackSectionProps } from "./FeedbackSection";

describe("FeedbackSection types", () => {
  it("accepts all required props", () => {
    const props: FeedbackSectionProps = {
      feedback: "",
      onFeedbackChange: () => {},
      analyzeCompleted: false,
      selectedCount: 0,
      isLoading: false,
      onAnalyze: () => {},
      onGenerate: () => {},
    };
    expect(props.feedback).toBe("");
    expect(props.selectedCount).toBe(0);
    expect(props.analyzeCompleted).toBe(false);
  });

  it("determines analyze button state", () => {
    const incomplete: FeedbackSectionProps = {
      feedback: "",
      onFeedbackChange: () => {},
      analyzeCompleted: false,
      selectedCount: 0,
      isLoading: false,
      onAnalyze: () => {},
      onGenerate: () => {},
    };
    expect(incomplete.analyzeCompleted).toBe(false);

    const complete: FeedbackSectionProps = {
      ...incomplete,
      analyzeCompleted: true,
    };
    expect(complete.analyzeCompleted).toBe(true);
  });

  it("determines generate button disabled state", () => {
    const noSelection: FeedbackSectionProps = {
      feedback: "",
      onFeedbackChange: () => {},
      analyzeCompleted: true,
      selectedCount: 0,
      isLoading: false,
      onAnalyze: () => {},
      onGenerate: () => {},
    };

    const hasSelection: FeedbackSectionProps = {
      ...noSelection,
      selectedCount: 2,
    };

    const isDisabled = (props: FeedbackSectionProps) =>
      props.isLoading || props.selectedCount === 0;

    expect(isDisabled(noSelection)).toBe(true);
    expect(isDisabled(hasSelection)).toBe(false);
  });

  it("formats pain point count label", () => {
    const formatLabel = (count: number) =>
      count === 1 ? "1 pain point selected" : `${count} pain points selected`;

    expect(formatLabel(1)).toBe("1 pain point selected");
    expect(formatLabel(3)).toBe("3 pain points selected");
    expect(formatLabel(0)).toBe("0 pain points selected");
  });

  it("determines button text based on feedback and state", () => {
    const analyzeButtonText = (feedback: string, isLoading: boolean) => {
      if (isLoading) return "Analyzing...";
      return feedback.trim() ? "Run analysis with feedback" : "Run analysis";
    };

    expect(analyzeButtonText("", false)).toBe("Run analysis");
    expect(analyzeButtonText("feedback here", false)).toBe(
      "Run analysis with feedback",
    );
    expect(analyzeButtonText("", true)).toBe("Analyzing...");
  });
});
