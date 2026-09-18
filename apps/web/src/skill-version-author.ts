// Product-made saves commit under the hub's fixed machine identity, shown
// as the product's own name until per-principal attribution lands.

const HUB_GIT_AUTHOR = "interchange-hub";

export function skillVersionSavedBy(author: string): string {
  return author.trim() === HUB_GIT_AUTHOR ? "Workbench" : author;
}
