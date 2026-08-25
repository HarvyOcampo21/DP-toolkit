"use strict";

// ═══════════════════════════════════════════════════════════════════════
// AUTO "ALL" FILTER CLICK — content script side
// ═══════════════════════════════════════════════════════════════════════
// Pairs with the "Auto-Refresh" toggle in the side panel (sidepanel.js)
// and the alarm in background.js. All this file does is: when asked,
// find the Photo Requests board's own "All" filter button (the first pill
// in the status filter row — All / Pending / Approved / Scheduled / Hold /
// Offplan Pending / Agent Requests / Upload Pending / Completed /
// Rejected) and click it, exactly as if a person had clicked it by hand.
//
// Matched by its text rather than a class name — "listing-pale" etc. are
// shared by every pill in that row, not just "All", and Vue's scoped
// data-v-* attribute hashes are the kind of thing that can silently change
// on the CRM's next deploy.
function findAllFilterButton() {
  const buttons = document.querySelectorAll(".field.has-addons .control > button.button");
  for (const btn of buttons) {
    const span = btn.querySelector("span");
    if (span && span.textContent.trim() === "All") return btn;
  }
  return null;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.type !== "DP_CLICK_ALL_FILTER") return false;

  const btn = findAllFilterButton();
  if (btn) {
    btn.click();
    sendResponse({ ok: true });
  } else {
    // Most likely this tab isn't currently on the Photo Requests list view
    // (e.g. it's sitting on a specific listing's drawer) — not an error
    // worth surfacing anywhere, just quietly skip this tick for this tab.
    sendResponse({ ok: false, error: "All filter button not found on this page." });
  }
  return true;
});
