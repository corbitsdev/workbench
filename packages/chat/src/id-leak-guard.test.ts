// CL-6471's systemic guard: no user-visible string may carry an internal
// identifier, in raw or humanized ("Run 737a058d…") form.
import { describe, expect, test } from "bun:test";
import { assertNoLeakedInternalId } from "./id-leak-guard";

describe("assertNoLeakedInternalId", () => {
  test("passes real, human-authored text through untouched", () => {
    expect(() =>
      assertNoLeakedInternalId("Architecture reviewer", "a display name"),
    ).not.toThrow();
    expect(() =>
      assertNoLeakedInternalId(
        "Hi Alice, I'm Myra — your teammate here.",
        "a greeting",
      ),
    ).not.toThrow();
  });

  test("catches a raw internal id for every named prefix", () => {
    const ids = [
      "run_737a058d48006e2bde12559576f422e0",
      "wfd_737a058d48006e2bde12559576f422e0",
      "tnt_737a058d48006e2bde12559576f422e0",
      "prn_737a058d48006e2bde12559576f422e0",
      "ast_737a058d48006e2bde12559576f422e0",
      "gtk_737a058d48006e2bde12559576f422e0",
    ];
    for (const id of ids) {
      expect(() => assertNoLeakedInternalId(id, "a name")).toThrow(
        /internal identifier/,
      );
    }
  });

  test("catches the humanized (Title Cased) form the same id renders as once split", () => {
    // `humanizeSlug`'s exact transform: "run_737a058d..." -> "Run 737a058d..."
    expect(() =>
      assertNoLeakedInternalId(
        "Run 737a058d48006e2bde12559576f422e0",
        "a participant name",
      ),
    ).toThrow(/internal identifier/);
  });

  test("catches an id leaked mid-sentence, as a greeting would carry it", () => {
    expect(() =>
      assertNoLeakedInternalId(
        "Hi Alice, I'm run_737a058d48006e2bde12559576f422e0. Three reviewers read every pull request.",
        "a greeting",
      ),
    ).toThrow(/internal identifier/);
  });

  test("never flags a short, coincidental substring match", () => {
    // "runner" starts with "run" but not the "run_" id prefix + hex tail.
    expect(() =>
      assertNoLeakedInternalId("Runner McRunface", "a display name"),
    ).not.toThrow();
  });
});
