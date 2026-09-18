// Every product-made save commits under the hub's fixed git identity, a
// machine account — shown as the product's own name, never that internal
// one, until per-principal attribution is plumbed through. A commit from
// outside the product keeps the real author name git recorded.

const HUB_GIT_AUTHOR = "interchange-hub";

export function skillVersionSavedBy(author: string): string {
  return author.trim() === HUB_GIT_AUTHOR ? "Workbench" : author;
}
