import { type } from 'arktype';

// The PRODUCT_SUITE_* attributes describe the visual suite, not the individual
// product. They share one shape: a free-text classification that is blank ("")
// when the catalog does not assert that attribute.
export const SuiteAttributes = type({
  designStyle: 'string',
  typeOnly: 'string',
  destination: 'string',
  cultural: 'string',
  religious: 'string',
  floral: 'string',
  location: 'string',
  typography: 'string',
  textFormat: 'string',
  artworkFormat: 'string',
  illustrationType: 'string',
  designElement: 'string',
  holiday: 'string',
  foil: 'string',
});
export type SuiteAttributes = typeof SuiteAttributes.infer;

// A single validated catalog row from Sheet1 (ported from the TKWW pilot's
// ProductRow). `imageLink` may be empty — an absent image is flagged downstream,
// not fatal. The three metadata fields carry the existing copy we improve,
// treated as prior art per the system prompt grounding rules.
export const SeoResourceRow = type({
  imageLink: 'string',
  productSuiteName: 'string > 0',
  productSuiteSlug: 'string',
  styles: 'string[]',
  productSlug: 'string > 0',
  productName: 'string > 0',
  productMetadataTitle: 'string',
  productMetadataDescription: 'string',
  summary: 'string',
  category: 'string',
  subCategory: 'string',
  tertiaryCategory: 'string',
  productNumPhotos: 'number >= 0',
  suite: SuiteAttributes,
});
export type SeoResourceRow = typeof SeoResourceRow.infer;

// The three output fields, grouped as the "current copy" prior art a downstream
// generate step compares against.
export interface CurrentCopy {
  metadataTitle: string;
  metadataDescription: string;
  summary: string;
}

export function currentCopy(row: SeoResourceRow): CurrentCopy {
  return {
    metadataTitle: row.productMetadataTitle,
    metadataDescription: row.productMetadataDescription,
    summary: row.summary,
  };
}

export interface RejectedRow {
  rowNumber: number;
  reason: string;
}

export interface SeoIngestResult {
  rows: SeoResourceRow[];
  rejected: RejectedRow[];
}
