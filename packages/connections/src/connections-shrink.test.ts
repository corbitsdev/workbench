// CL-7593: shrink @corbits/connections to the PKCE OAuth client +
// callback surface. Guards the cutover: the one-time CL-7242
// duplicate-grant cleanup entry point must stay gone (module file and
// export-map subpath) so no caller can drift back onto a custom grant
// flow outside the native credential/grant routes.
import { expect, test } from "bun:test";

const here = new URL(".", import.meta.url);

test("duplicate-grant reconcile entry point stays deleted", async () => {
  expect(await Bun.file(new URL("./reconcile-duplicate-repo-grants.ts", here)).exists()).toBe(
    false,
  );
  const pkg = JSON.parse(await Bun.file(new URL("../package.json", here)).text()) as {
    exports?: Record<string, string>;
  };
  expect(Object.hasOwn(pkg.exports ?? {}, "./reconcile-duplicate-repo-grants")).toBe(false);
});
