// Leaf module (no imports) so both seo.ts and the prompt blocks can read these
// without forming an import cycle.
export const SEO_VARIANT_COUNT = 5;

// The selection field names the SEO output maps onto, in display order.
export const SEO_SELECTION_FIELDS = ['Title', 'Description', 'Summary'] as const;
