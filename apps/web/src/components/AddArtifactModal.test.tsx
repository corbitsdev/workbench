/// <reference types="bun" />
import "../test-setup";
import { afterEach, describe, expect, it, mock } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import React from "react";

const mutateAsync = mock<
  (params: Record<string, unknown>) => Promise<{ id: string }>
>(() => Promise.resolve({ id: "art-new" }));

mock.module("@workbench/client/react", () => ({
  useCreateArtifact: () => ({ mutateAsync, isPending: false }),
}));

import { AddArtifactModal } from "./AddArtifactModal";

afterEach(() => {
  cleanup();
  mutateAsync.mockClear();
});

describe("AddArtifactModal", () => {
  it("renders nothing when closed", () => {
    const { container } = render(
      React.createElement(AddArtifactModal, {
        open: false,
        onClose: () => {},
      }),
    );
    expect(container.firstChild).toBeNull();
  });

  it("submits a url-mode artifact and surfaces the new id on success", async () => {
    const onCreated = mock((_id: string) => {});
    const onClose = mock(() => {});
    render(
      React.createElement(AddArtifactModal, {
        open: true,
        tenantId: "tn-1",
        onClose,
        onCreated,
      }),
    );

    fireEvent.change(screen.getByPlaceholderText("Name this artifact"), {
      target: { value: "Docs page" },
    });
    fireEvent.change(screen.getByPlaceholderText("https://example.com/page"), {
      target: { value: "https://example.com/x" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add artifact" }));

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mutateAsync).toHaveBeenCalledWith({
      tenantId: "tn-1",
      mode: "url",
      title: "Docs page",
      content: "https://example.com/x",
    });
    expect(onCreated).toHaveBeenCalledWith("art-new");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("blocks submission with an empty title or content", () => {
    render(
      React.createElement(AddArtifactModal, {
        open: true,
        onClose: () => {},
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Add artifact" }));
    expect(mutateAsync).not.toHaveBeenCalled();
    screen.getByText("Both a title and a value are required.");
  });

  it("switches to paste-text mode and submits a manual artifact", async () => {
    render(
      React.createElement(AddArtifactModal, {
        open: true,
        onClose: () => {},
      }),
    );
    fireEvent.click(screen.getByRole("tab", { name: "Paste text" }));
    fireEvent.change(screen.getByPlaceholderText("Name this artifact"), {
      target: { value: "My note" },
    });
    fireEvent.change(
      screen.getByPlaceholderText("Paste the content to store as an artifact"),
      { target: { value: "the body" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Add artifact" }));

    await Promise.resolve();
    expect(mutateAsync).toHaveBeenCalledWith({
      tenantId: undefined,
      mode: "text",
      title: "My note",
      content: "the body",
    });
  });
});
