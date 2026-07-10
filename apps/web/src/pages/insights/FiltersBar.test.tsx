import "../../test-setup";
import { afterEach, describe, expect, it, mock } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { FiltersBar } from "./FiltersBar";

describe("FiltersBar", () => {
  afterEach(() => cleanup());

  it("renders kind and actor filters with test ids", () => {
    render(
      <FiltersBar
        kinds={["seo-enrichment", "gamma"]}
        kindFilter="all"
        onKindFilter={mock(() => {})}
        actorFilter="all"
        onActorFilter={mock(() => {})}
      />,
    );

    expect(screen.getByTestId("filters-bar")).toBeDefined();
    expect(screen.getByTestId("kind-filter")).toBeDefined();
    expect(screen.getByTestId("actor-filter")).toBeDefined();
  });

  it("calls onKindFilter when kind changes", () => {
    const onKind = mock(() => {});
    render(
      <FiltersBar
        kinds={["gamma"]}
        kindFilter="all"
        onKindFilter={onKind}
        actorFilter="all"
        onActorFilter={mock(() => {})}
      />,
    );

    fireEvent.change(screen.getByTestId("kind-filter"), {
      target: { value: "gamma" },
    });
    expect(onKind).toHaveBeenCalledWith("gamma");
  });

  it("calls onActorFilter when actor changes", () => {
    const onActor = mock(() => {});
    render(
      <FiltersBar
        kinds={[]}
        kindFilter="all"
        onKindFilter={mock(() => {})}
        actorFilter="all"
        onActorFilter={onActor}
      />,
    );

    fireEvent.change(screen.getByTestId("actor-filter"), {
      target: { value: "me" },
    });
    expect(onActor).toHaveBeenCalledWith("me");
  });
});
