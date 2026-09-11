"use strict";

// ═══════════════════════════════════════════════════════════════════════
// AUTO-FILL LOCATION FILTER — content script side
// ═══════════════════════════════════════════════════════════════════════
// Receives DP_FILL_LOCATION_FILTER from background.js (relayed from the
// Copier Tools card's Auto-Fill button — see copier-content.js) and fills
// the CRM's own advanced filter panel: Location and Unit / Plot No.
// Those two fields don't exist in the DOM at all until the "Open Filter"
// toggle is clicked, and the panel's expansion isn't instant either — so
// this always clicks that toggle first and polls briefly for the fields
// to actually appear, rather than assuming either one. Matched by stable
// data-tooltip/placeholder/label attributes rather than the Vue-scoped
// classes visible in DevTools (cust-inpu-style, pb-0, etc.) — those are
// exactly the kind of thing that silently changes on the CRM's next
// deploy, same rationale as auto-all-click-content.js's "All" filter
// button.
//
// Registered site-wide (matches newcrm.drivenproperties.com/*, same as
// select.js) rather than scoped to /photorequest/* the way
// copier-content.js is — the button that triggers this lives on the
// Photo Requests page, but the filter panel being filled could be open on
// any CRM page background.js decides to target, and the brief for this
// feature is explicit that a target tab NOT on Photo Requests should
// still be attempted, not treated as an error up front.

// UIFIX-02: corrected against the actual markup — the toggle's real
// attribute is data-tooltip="Open Filter", not "More Filters" as
// originally guessed from the hover tooltip text (AUTOFILL-01/UIFIX-01).
// The class below (.icon-filter-search-style.suffix-filter-icon) is kept
// as a secondary match in case a future CRM deploy changes the
// data-tooltip text again but leaves the icon's own class alone.
//
// DEBUG-01: the selector itself was confirmed correct via DevTools, but a
// plain .click() on this element wasn't opening the panel. Kept as a
// standalone lookup (rather than folded into openFilterPanel below) since
// it's also used on its own by the "does it already exist" check further
// down — visibility-filtered so a hidden duplicate elsewhere in the DOM
// (see DEBUG-01 point 3) doesn't get preferred over the one actually on
// screen.
function isVisible(el) {
  return !!el && el.offsetParent !== null;
}

function findMoreFiltersToggle() {
  const candidates = Array.from(
    document.querySelectorAll('svg[data-tooltip="Open Filter"], .icon-filter-search-style.suffix-filter-icon')
  );
  if (candidates.length === 0) return null;
  // querySelectorAll with a comma-list already de-dupes a single element
  // matching both parts of the selector, so this filter is purely about
  // picking the visible one out of genuinely distinct matches.
  return candidates.find(isVisible) || candidates[0];
}

function findLocationInput() {
  return document.querySelector('input[placeholder="Location"]');
}

// The Unit/Plot No field has no stable attribute of its own to match —
// matched instead by its preceding <h6>Unit / Plot No</h6> label text,
// per the brief, then the first <input> found within that label's parent
// container.
function findUnitPlotInput() {
  const headings = document.querySelectorAll("h6");
  for (const h of headings) {
    if (h.textContent.trim() === "Unit / Plot No") {
      const container = h.parentElement;
      const input = container && container.querySelector("input");
      if (input) return input;
    }
  }
  return null;
}

// Dispatches both input and change (unlike default-page-size-content.js,
// which deliberately only dispatches change to avoid tripping its own
// manual-override detector) — a plain text field bound to Vue's v-model
// typically reacts to `input`, not `change`, so both are dispatched here
// to give the CRM's own reactive state the best chance of actually
// picking this up, not just the raw DOM value.
function setFieldValue(input, value) {
  if (!input) return false;
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
  return true;
}

function waitFor(checkFn, attempts, delayMs) {
  return new Promise(resolve => {
    let tries = 0;
    (function tick() {
      const result = checkFn();
      if (result) { resolve(result); return; }
      tries += 1;
      if (tries >= attempts) { resolve(null); return; }
      setTimeout(tick, delayMs);
    })();
  });
}

// DEBUG-01 — dispatches a real mousedown→mouseup→click sequence, since
// Vue's directive on this element may not respond the same way a plain
// `element.click()` does.
function fireFullClick(el) {
  if (!el) return false;
  const opts = { bubbles: true, cancelable: true, view: window };
  el.dispatchEvent(new MouseEvent("mousedown", opts));
  el.dispatchEvent(new MouseEvent("mouseup", opts));
  el.dispatchEvent(new MouseEvent("click", opts));
  return true;
}

// DEBUG-01 point 1 — the SVG sits inside a <span class="tooltip__container">
// (or similar), and Vue's @click is plausibly bound to that wrapper, not
// the <svg> itself. Returns the wrapper first (if one exists and differs
// from the icon), then the icon itself, as separate candidates — never
// combined into one click, since firing both on a toggle would just
// re-close whatever the first one opened.
function getToggleClickTargets(iconEl) {
  const wrapper = iconEl.closest('span, button, [role="button"]');
  const targets = [];
  if (wrapper && wrapper !== iconEl) targets.push(wrapper);
  targets.push(iconEl);
  return targets;
}

// Tries each (target × click-method) combination in turn — wrapper before
// icon, full synthetic event before plain .click() — checking after each
// one whether the Location field actually appeared before moving to the
// next. Strictly sequential and stops at the first success, both to avoid
// wasted attempts and because firing a second click strategy after one
// that already worked would toggle the panel back closed.
async function openFilterPanel() {
  // DEBUG-01 point 4 — confirm the toggle exists AND is actually rendered
  // (offsetParent !== null) before ever attempting a click, rather than
  // assuming it's there the instant this message is received; Vue may not
  // have mounted this part of the page yet.
  const toggle = await waitFor(findMoreFiltersToggle, 10, 150);
  if (!toggle) {
    return { ok: false, error: '"Open Filter" toggle not found (or not visible) on this page.' };
  }

  const targets = getToggleClickTargets(toggle);
  const attempts = [
    ...targets.map(target => () => fireFullClick(target)),
    ...targets.map(target => () => { target.click(); return true; }),
  ];

  for (const attempt of attempts) {
    attempt();
    const appeared = await waitFor(findLocationInput, 4, 150);
    if (appeared) return { ok: true };
  }

  return { ok: false, error: "Clicked the filter toggle but the panel never opened." };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.type !== "DP_FILL_LOCATION_FILTER") return false;

  (async () => {
    // The Location/Unit fields only exist in the DOM once "Open Filter"
    // is actually expanded — use their presence as the "is it already
    // open" signal rather than tracking open/closed state separately,
    // since that state could drift out of sync with reality.
    if (!findLocationInput()) {
      const result = await openFilterPanel();
      if (!result.ok) {
        sendResponse({ ok: false, error: result.error });
        return;
      }
    }

    const locationInput = findLocationInput();
    const unitPlotInput = findUnitPlotInput();

    if (!locationInput && !unitPlotInput) {
      sendResponse({ ok: false, error: "Neither the Location nor the Unit/Plot No field could be found on this page." });
      return;
    }

    let filled = 0;
    if (message.location && setFieldValue(locationInput, message.location)) filled += 1;
    if (message.unitPlot && setFieldValue(unitPlotInput, message.unitPlot)) filled += 1;

    if (filled === 0) {
      sendResponse({ ok: false, error: "Found the filter fields but had nothing to fill them with." });
      return;
    }

    sendResponse({ ok: true, filled });
  })();

  return true; // async response
});

