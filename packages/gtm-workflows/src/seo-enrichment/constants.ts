// Leaf module (no imports) so both seo.ts and the prompt blocks can read these
// without forming an import cycle.
export const SEO_VARIANT_COUNT = 5;

// The selection field names the SEO output maps onto, in display order.
export const SEO_SELECTION_FIELDS = ['Title', 'Description', 'Summary'] as const;

// Multimodal inference for per-row enrich — matches tkww-pilot GEMINI_SOURCE.
export const SEO_INFERENCE_CREDENTIAL_NAME = 'google-ai';
export const SEO_INFERENCE_PROVIDER = 'google-genai';
export const SEO_INFERENCE_MODEL = 'gemini-3.1-flash-lite';
export const SEO_INFERENCE_BASE_URL = 'https://generativelanguage.googleapis.com';
