/// <reference types="bun" />
import "../test-setup";
import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import type { ActiveContext } from "@workbench/shared";
import {
  ActiveContextProvider,
  useActiveContext,
  usePublishActiveContext,
} from "./active-context-store";

const ARTIFACT: ActiveContext = {
  kind: "artifact",
  id: "art_1",
  label: "Launch brief",
  artifactKind: "blog",
  body: "hello",
};

function Reader() {
  const ctx = useActiveContext();
  return (
    <div data-testid="reader">{ctx ? `${ctx.kind}:${ctx.id}` : "none"}</div>
  );
}

function Publisher({ ctx }: { ctx: ActiveContext | null }) {
  usePublishActiveContext(ctx);
  return null;
}

afterEach(cleanup);

describe("ActiveContextProvider", () => {
  it("exposes the published surface to a reader", () => {
    render(
      <ActiveContextProvider>
        <Publisher ctx={ARTIFACT} />
        <Reader />
      </ActiveContextProvider>,
    );
    expect(screen.getByTestId("reader").textContent).toBe("artifact:art_1");
  });

  it("clears the surface when the publisher unmounts", () => {
    function Host({ show }: { show: boolean }) {
      return (
        <ActiveContextProvider>
          {show && <Publisher ctx={ARTIFACT} />}
          <Reader />
        </ActiveContextProvider>
      );
    }
    const { rerender } = render(<Host show={true} />);
    expect(screen.getByTestId("reader").textContent).toBe("artifact:art_1");

    rerender(<Host show={false} />);
    expect(screen.getByTestId("reader").textContent).toBe("none");
  });

  it("keeps the incoming surface when one publishing page replaces another", () => {
    // Navigating between two publishable pages unmounts the old publisher and
    // mounts a new one. The distinct keys force that swap, so this guards that
    // the old publisher's unmount-clear does not clobber the new publish.
    const SECOND: ActiveContext = {
      kind: "artifact",
      id: "art_2",
      label: "Other brief",
      artifactKind: "blog",
      body: "world",
    };
    function Host({ which }: { which: "a" | "b" }) {
      return (
        <ActiveContextProvider>
          {which === "a" ? (
            <Publisher key="a" ctx={ARTIFACT} />
          ) : (
            <Publisher key="b" ctx={SECOND} />
          )}
          <Reader />
        </ActiveContextProvider>
      );
    }
    const { rerender } = render(<Host which="a" />);
    expect(screen.getByTestId("reader").textContent).toBe("artifact:art_1");

    rerender(<Host which="b" />);
    expect(screen.getByTestId("reader").textContent).toBe("artifact:art_2");
  });

  it("reads null when used outside the provider", () => {
    render(<Reader />);
    expect(screen.getByTestId("reader").textContent).toBe("none");
  });
});
