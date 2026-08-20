import { afterEach, describe, expect, test } from "bun:test";

import {
  isBlockingOverlayOpen,
  isInsideInteractiveInput,
} from "../src/dialog-guard";

afterEach(() => {
  document.body.innerHTML = "";
});

describe("isBlockingOverlayOpen", () => {
  test("false with no dialog in the document", () => {
    expect(isBlockingOverlayOpen()).toBe(false);
  });

  test("true once a role=dialog element is mounted", () => {
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    document.body.appendChild(dialog);
    expect(isBlockingOverlayOpen()).toBe(true);
  });

  test("false again once the dialog unmounts", () => {
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    document.body.appendChild(dialog);
    dialog.remove();
    expect(isBlockingOverlayOpen()).toBe(false);
  });
});

describe("isInsideInteractiveInput", () => {
  test("true for an input element", () => {
    const input = document.createElement("input");
    document.body.appendChild(input);
    expect(isInsideInteractiveInput(input)).toBe(true);
  });

  test("true for a descendant of a contenteditable region", () => {
    const editable = document.createElement("div");
    editable.setAttribute("contenteditable", "true");
    const span = document.createElement("span");
    editable.appendChild(span);
    document.body.appendChild(editable);
    expect(isInsideInteractiveInput(span)).toBe(true);
  });

  test("false for a plain row", () => {
    const row = document.createElement("div");
    document.body.appendChild(row);
    expect(isInsideInteractiveInput(row)).toBe(false);
  });

  test("false for a non-Element target", () => {
    expect(isInsideInteractiveInput(null)).toBe(false);
  });
});
