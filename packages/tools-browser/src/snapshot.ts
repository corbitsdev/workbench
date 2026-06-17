/**
 * Accessibility-ish snapshot of a page's interactive elements.
 *
 * The browser-side script (SNAPSHOT_SCRIPT) only reports raw facts about each
 * candidate element. All judgment — ref selection, pruning, capping, dedup —
 * happens here in Node, as pure functions, so it is unit-testable without a
 * browser.
 *
 * Coverage: the script walks the top document, descends into open shadow roots
 * (Playwright CSS pierces these, so their refs resolve from the page), and
 * recurses same-origin iframe documents (tagging elements with a frame chain so
 * click/type resolve via frameLocator). Cross-origin iframes cannot be read from
 * page script (same-origin policy); they are counted, not traversed.
 */
import type { RawElement, SnapshotElement } from "./types";

/** Hard cap on elements returned to the model, to bound token cost. */
export const MAX_SNAPSHOT_ELEMENTS = 100;
/** Max characters of an element's accessible name. */
const MAX_NAME_LENGTH = 120;
/** Separates frame selectors from the element selector in a ref. */
export const FRAME_DELIMITER = " >>> ";

/**
 * Script evaluated in the page. Returns interactive elements (across shadow
 * roots and same-origin iframes) plus the total iframe count. Kept as a string
 * (not a function) so the package needs no DOM lib at the call site.
 */
export const SNAPSHOT_SCRIPT = `(() => {
  const SELECTOR = [
    'a[href]', 'button', 'input', 'select', 'textarea',
    '[role=button]', '[role=link]', '[role=textbox]', '[role=checkbox]',
    '[role=tab]', '[role=menuitem]', '[contenteditable=""]', '[contenteditable=true]',
    '[tabindex]'
  ].join(',');
  const MAX_NAME = ${MAX_NAME_LENGTH};
  const FRAME_DELIMITER = ${JSON.stringify(FRAME_DELIMITER)};
  function viewOf(el) {
    return (el.ownerDocument && el.ownerDocument.defaultView) || window;
  }
  function isVisible(el) {
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const style = viewOf(el).getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none') return false;
    return el.offsetParent !== null || style.position === 'fixed';
  }
  // Path within the element's own root (document or shadow root). Stops at the
  // root host so the selector is valid inside that root / frame.
  function pathOf(el) {
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && node.tagName.toLowerCase() !== 'html') {
      const tag = node.tagName.toLowerCase();
      let nth = 1;
      let sib = node.previousElementSibling;
      while (sib) {
        if (sib.tagName.toLowerCase() === tag) nth++;
        sib = sib.previousElementSibling;
      }
      parts.unshift(tag + ':nth-of-type(' + nth + ')');
      node = node.parentElement;
    }
    return parts.join(' > ');
  }
  function nameOf(el) {
    const aria = el.getAttribute('aria-label');
    if (aria && aria.trim()) return aria.trim().slice(0, MAX_NAME);
    if (el.tagName.toLowerCase() === 'input') {
      const placeholder = el.getAttribute('placeholder');
      if (placeholder && placeholder.trim()) return placeholder.trim().slice(0, MAX_NAME);
      const value = el.getAttribute('value');
      if (value && value.trim()) return value.trim().slice(0, MAX_NAME);
    }
    const text = (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
    return text.slice(0, MAX_NAME);
  }
  function describe(el, frame) {
    return {
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute('role'),
      name: nameOf(el),
      id: el.id || null,
      testId: el.getAttribute('data-testid'),
      nameAttr: el.getAttribute('name'),
      ariaLabel: el.getAttribute('aria-label'),
      text: (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, MAX_NAME) || null,
      path: pathOf(el),
      frame: frame,
      visible: isVisible(el)
    };
  }
  const out = [];
  const counts = { iframes: 0 };
  function collect(root, frame) {
    const nodes = Array.from(root.querySelectorAll(SELECTOR));
    for (const el of nodes) out.push(describe(el, frame));
    // Open shadow roots — same frame; Playwright CSS pierces them.
    for (const host of Array.from(root.querySelectorAll('*'))) {
      if (host.shadowRoot) collect(host.shadowRoot, frame);
    }
    // Same-origin iframes — recurse into their document under a frame chain.
    for (const iframe of Array.from(root.querySelectorAll('iframe'))) {
      counts.iframes++;
      let doc = null;
      try { doc = iframe.contentDocument; } catch (e) { doc = null; }
      if (doc) {
        const childFrame = (frame ? frame + FRAME_DELIMITER : '') + pathOf(iframe);
        collect(doc, childFrame);
      }
    }
  }
  collect(document, null);
  return { elements: out, iframeCount: counts.iframes };
})()`;

export type RawSnapshot = {
  elements: RawElement[];
  iframeCount: number;
};

function attrSelector(attr: string, value: string): string {
  return `[${attr}=${JSON.stringify(value)}]`;
}

/**
 * Pick the most stable selector for an element within its own root. Stability
 * order: id, test id, name attribute, aria-label, then a structural
 * nth-of-type path.
 */
export function buildRef(element: RawElement): string {
  if (element.id && element.id.length > 0)
    return attrSelector("id", element.id);
  if (element.testId && element.testId.length > 0)
    return attrSelector("data-testid", element.testId);
  if (element.nameAttr && element.nameAttr.length > 0) {
    return `${element.tag}${attrSelector("name", element.nameAttr)}`;
  }
  if (element.ariaLabel && element.ariaLabel.length > 0) {
    return `${element.tag}${attrSelector("aria-label", element.ariaLabel)}`;
  }
  return element.path;
}

function countRefs(entries: { ref: string }[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const { ref } of entries) {
    counts.set(ref, (counts.get(ref) ?? 0) + 1);
  }
  return counts;
}

/**
 * Make a list of (element, inner ref) entries unique among themselves: demote
 * ambiguous attribute refs to their structural path, then append a Playwright
 * `>> nth=` suffix to anything still colliding. Runs per-frame, since each
 * frame is a separate selector scope.
 */
function uniquifyInner(entries: { el: RawElement; ref: string }[]) {
  const stableCounts = countRefs(entries);
  const demoted = entries.map(({ el, ref }) =>
    (stableCounts.get(ref) ?? 0) > 1 ? { el, ref: el.path } : { el, ref },
  );
  const finalCounts = countRefs(demoted);
  const seen = new Map<string, number>();
  return demoted.map(({ el, ref }) => {
    if ((finalCounts.get(ref) ?? 0) <= 1) return { el, ref };
    const index = seen.get(ref) ?? 0;
    seen.set(ref, index + 1);
    return { el, ref: `${ref} >> nth=${index}` };
  });
}

/**
 * Prune a raw snapshot into the model-facing element list: visible elements
 * only, refs made unique within each frame, then frame-qualified so they are
 * globally unique and resolvable (`<frame> >>> <element>`). Capped with a
 * truncation flag. Every emitted ref resolves to exactly one element, so a
 * later click can never be ambiguous.
 */
export function pruneSnapshot(raw: RawSnapshot, url: string) {
  const visible = raw.elements.filter((el) => el.visible);

  // Group by frame — each frame is its own selector scope.
  const byFrame = new Map<string, RawElement[]>();
  for (const el of visible) {
    const key = el.frame ?? "";
    const group = byFrame.get(key);
    if (group) group.push(el);
    else byFrame.set(key, [el]);
  }

  // Preserve original document order across the flattened result.
  const refByElement = new Map<RawElement, string>();
  for (const [frame, group] of byFrame) {
    const unique = uniquifyInner(
      group.map((el) => ({ el, ref: buildRef(el) })),
    );
    for (const { el, ref } of unique) {
      refByElement.set(
        el,
        frame.length > 0 ? `${frame}${FRAME_DELIMITER}${ref}` : ref,
      );
    }
  }

  const ordered = visible.map((el) => ({
    el,
    ref: refByElement.get(el) ?? buildRef(el),
  }));
  const capped = ordered.slice(0, MAX_SNAPSHOT_ELEMENTS);
  const elements: SnapshotElement[] = capped.map(({ el, ref }) => ({
    ref,
    role: el.role ?? el.tag,
    name: el.name ?? el.text ?? "",
  }));

  return {
    url,
    elements,
    truncated: ordered.length > capped.length,
    iframeCount: raw.iframeCount,
  };
}
