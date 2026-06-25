import { afterEach, describe, expect, it, mock } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FileInput } from "./FileInput";

afterEach(cleanup);

describe("FileInput", () => {
  it("opens the native picker when the trigger is clicked", async () => {
    const user = userEvent.setup();
    const onChange = mock(() => {});
    render(
      <FileInput
        accept=".xlsx"
        triggerLabel="Choose file"
        onChange={onChange}
      />,
    );
    const input = document.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;
    const clickSpy = mock(() => {});
    input.click = clickSpy;

    await user.click(screen.getByRole("button", { name: "Choose file" }));

    expect(clickSpy).toHaveBeenCalledTimes(1);
  });

  it("forwards file selection to onChange", async () => {
    const user = userEvent.setup();
    const onChange = mock(() => {});
    render(
      <FileInput
        accept=".xlsx"
        triggerLabel="Choose file"
        onChange={onChange}
      />,
    );
    const input = document.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;
    const file = new File(["data"], "catalog.xlsx", {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });

    await user.upload(input, file);

    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("shows the pending label while uploading", () => {
    render(
      <FileInput
        accept=".xlsx"
        triggerLabel="Choose file"
        pendingLabel="Uploading…"
        isPending
        onChange={() => {}}
      />,
    );
    expect(screen.getByRole("button", { name: "Uploading…" })).toBeDefined();
  });
});
