"use strict";

// ═══════════════════════════════════════════════════════════════════════
// AUTO-FILL LOCATION FILTER — content script side
// ═══════════════════════════════════════════════════════════════════════
// Receives DP_FILL_LOCATION_FILTER from background.js (relayed from the
// Copier Tools card's Auto-Fill button — see copier-content.js) and fills
// the CRM's own advanced filter panel: Location and Unit / Plot No,
// opening the filter panel first if it isn't already open. Matched by
// stable data-tooltip/placeholder/label attributes rather than the
// Vue-scoped classes visible in DevTools (cust-inpu-style, pb-0, etc.) —
// those are exactly the kind of thing that silently changes on the CRM's
// next deploy, same rationale as auto-all-click-content.js's "All" filter
// button.
//
// Registered site-wide (matches newcrm.drivenproperties.com/*, same as
// select.js) rather than scoped to /photorequest/* the way
// copier-content.js is — the button that triggers this lives on the
// Photo Requests page, but the filter panel being filled could be open on
// any CRM page background.js decides to target, and the brief for this
// feature is explicit that a target tab NOT on Photo Requests should
// still be attempted, not treated as an error up front.

function findFilterToggle() {
  return document.querySelector('[data-tooltip="Open Filter"]');
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

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.type !== "DP_FILL_LOCATION_FILTER") return false;

  (async () => {
    // The Location/Unit fields only exist in the DOM once the filter
    // panel is actually expanded — use their presence as the "is it
    // already open" signal rather than tracking open/closed state
    // separately, since that state could drift out of sync with reality.
    if (!findLocationInput()) {
      const toggle = findFilterToggle();
      if (!toggle) {
        sendResponse({ ok: false, error: "Filter toggle not found on this page." });
        return;
      }
      toggle.click();
      const appeared = await waitFor(findLocationInput, 10, 300);
      if (!appeared) {
        sendResponse({ ok: false, error: "Filter panel did not open in time." });
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
