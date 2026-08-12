import { afterEach, describe, expect, test } from "bun:test";

import {
  consumePendingLibraryUpload,
  requestLibraryUpload,
  resetPendingLibraryUpload,
} from "./library-upload";

afterEach(() => {
  resetPendingLibraryUpload();
});

describe("requestLibraryUpload", () => {
  test("on library does not navigate or set pending", () => {
    const navigated: string[] = [];
    requestLibraryUpload({
      alreadyOnLibrary: true,
      navigateToLibrary: () => {
        navigated.push("/library");
      },
    });
    expect(navigated).toEqual([]);
    expect(consumePendingLibraryUpload()).toBe(false);
  });

  test("off library sets pending, navigates, and consume is one-shot", () => {
    const navigated: string[] = [];
    requestLibraryUpload({
      alreadyOnLibrary: false,
      navigateToLibrary: () => {
        navigated.push("/library");
      },
    });
    expect(navigated).toEqual(["/library"]);
    expect(consumePendingLibraryUpload()).toBe(true);
    expect(consumePendingLibraryUpload()).toBe(false);
  });
});
