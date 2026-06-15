// Per-product-type context blocks, keyed off Category / Sub Category /
// Tertiary Category. Seeded with generic-but-accurate wedding-stationery
// context per type; adding a new type is just one more registry entry. Keys are
// the real field values that appear in ingested rows, lowercased; aliases point
// a few sub/tertiary-category spellings at the same block.

import type { PromptBlock } from './blocks';

export interface ProductCategory {
  category?: string;
  subCategory?: string;
  tertiaryCategory?: string;
}

const INVITATION_BLOCK: PromptBlock = {
  id: 'type:invitation',
  label: 'PRODUCT TYPE: Invitation',
  body: 'Wedding invitations announce the event and set its tone. Emphasize the headline wording, design motif and border, paper or card stock, format (flat or folded), and how the piece anchors the wider suite. Ground every concrete claim in the image or metadata; do not invent wording, materials, or sizes.',
};

const SAVE_THE_DATE_BLOCK: PromptBlock = {
  id: 'type:save-the-date',
  label: 'PRODUCT TYPE: Save the Date',
  body: 'Save the dates give guests early notice of the wedding date and location. Emphasize the announcement tone, design motif, and format (card, magnet, or photo). Reference dates, names, or locations only when supplied.',
};

const ENCLOSURE_CARD_BLOCK: PromptBlock = {
  id: 'type:enclosure-card',
  label: 'PRODUCT TYPE: Enclosure Card',
  body: 'Enclosure cards accompany the invitation with details such as RSVP, reception, accommodations, or directions. Emphasize how the card coordinates with the invitation suite and its specific informational role. State details only when present in metadata.',
};

const SIGN_BLOCK: PromptBlock = {
  id: 'type:sign',
  label: 'PRODUCT TYPE: Sign',
  body: 'Wedding signs display information or welcome messages at the venue. Emphasize readability at a distance, display format (poster, board, or framed print), and how the design ties into the wedding theme. Quote sign wording only when supplied.',
};

const GUEST_BOOK_CARD_BLOCK: PromptBlock = {
  id: 'type:guest-book-card',
  label: 'PRODUCT TYPE: Guest Book Card',
  body: 'Guest book cards collect individual messages or advice from guests to assemble into a keepsake. Emphasize prompt wording, card format, and coordination with the suite. Keep the tone warm and sentimental.',
};

// The keyed registry. Keys are lowercase product-type names matched
// case-insensitively against a product's category fields.
export const PRODUCT_TYPE_BLOCKS: Readonly<Record<string, PromptBlock>> = {
  invitation: INVITATION_BLOCK,
  invitations: INVITATION_BLOCK,
  'wedding invitations': INVITATION_BLOCK,
  'save the date': SAVE_THE_DATE_BLOCK,
  'save the dates': SAVE_THE_DATE_BLOCK,
  'enclosure card': ENCLOSURE_CARD_BLOCK,
  'enclosure cards': ENCLOSURE_CARD_BLOCK,
  sign: SIGN_BLOCK,
  signs: SIGN_BLOCK,
  'guest book card': GUEST_BOOK_CARD_BLOCK,
  'guest book cards': GUEST_BOOK_CARD_BLOCK,
  'seating charts': {
    id: 'type:seating-charts',
    label: 'PRODUCT TYPE: Seating Charts',
    body: "Seating charts guide guests to their tables at the reception. Emphasize legible organization, display format (framed, mirror, board, or panel), and how the design ties into the wedding's theme. Mention personalization of guest and table names only when supplied.",
  },
  menus: {
    id: 'type:menus',
    label: 'PRODUCT TYPE: Menus',
    body: 'Wedding menus present the meal courses at each place setting or table. Emphasize course listing, paper stock, layout, and how the menu coordinates with the wider stationery suite. Reference specific dishes only when present in metadata.',
  },
  'bar signs': {
    id: 'type:bar-signs',
    label: 'PRODUCT TYPE: Bar Signs',
    body: 'Bar signs display drink menus or signature cocktails at the reception bar. Emphasize readability from a distance, display format (sign, print, or board), and playful-yet-tasteful tone. Name specific drinks only when supplied.',
  },
  'place cards': {
    id: 'type:place-cards',
    label: 'PRODUCT TYPE: Place Cards',
    body: "Place cards mark each guest's assigned seat. Emphasize personalization of guest names, tent vs. flat format, paper or material, and how they coordinate with the table setting. Do not invent guest names or quantities.",
  },
  'guest books': {
    id: 'type:guest-books',
    label: 'PRODUCT TYPE: Guest Books',
    body: 'Guest books collect messages and signatures from wedding guests as a keepsake. Emphasize cover material, page count or format, personalization options, and the sentimental, lasting nature of the piece.',
  },
  'envelope liners': {
    id: 'type:envelope-liners',
    label: 'PRODUCT TYPE: Envelope Liners',
    body: 'Envelope liners add a decorative interior to invitation envelopes. Emphasize pattern or color, the reveal moment when opening, and coordination with the invitation suite. State materials only when supplied.',
  },
  'favor bags': {
    id: 'type:favor-bags',
    label: 'PRODUCT TYPE: Favor Bags',
    body: 'Favor bags hold parting gifts for guests. Emphasize material, size suitability for common favors, personalization, and how the design echoes the wedding theme. Do not invent contents or dimensions.',
  },
};

// Select the per-type block for a product. Matches case-insensitively on
// tertiaryCategory first, then subCategory, then category. Returns undefined
// when nothing matches (the assembler then appends no per-type block).
export function selectProductTypeBlock(product: ProductCategory): PromptBlock | undefined {
  const candidates = [product.tertiaryCategory, product.subCategory, product.category];
  for (const candidate of candidates) {
    if (candidate === undefined) continue;
    const block = PRODUCT_TYPE_BLOCKS[candidate.trim().toLowerCase()];
    if (block !== undefined) return block;
  }
  return undefined;
}
