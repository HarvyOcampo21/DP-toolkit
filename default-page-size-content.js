"use strict";

// ═══════════════════════════════════════════════════════════════════════
// DEFAULT "ITEMS PER PAGE" TO 100 — content script side
// ═══════════════════════════════════════════════════════════════════════
// Finds the Photo Requests list view's own "items per page" dropdown and
// sets it to 100, dispatching a real change event so the CRM's own logic
// picks it up and re-fetches the list — same idea as
// auto-all-click-content.js's approach to triggering the CRM's own UI
// programmatically rather than reimplementing its pagination logic here.
//
// Important distinction from that file: Auto-click All deliberately
// re-applies periodically (via an alarm), because the CRM can reset that
// filter state on its own. This is a ONE-TIME default per page
// load/view-entry, not a recurring override — if someone manually changes
// it to 10/25/50 during their session, this leaves it alone rather than
// fighting them back to 100 on the next tick. appliedThisView only resets
// on hashchange (navigating into the list view fresh), same
// SPA-navigation-watcher pattern already used in quick-copy-content.js —
// the interval below just polls for the dropdown to exist yet (it may not
// have rendered when this script first runs, or right after navigating
// back to the list), not for a reason to re-apply.
let appliedThisView = false;

function findPerPageSelect() {
  const container = document.querySelector(".dds__pagination__per-page-select");
  return container ? container.querySelector("select") : null;
}

function applyDefaultPageSize() {
  if (appliedThisView) return;

  const select = findPerPageSelect();
  if (!select) return; // not on the list view yet, or it hasn't rendered — retry next tick

  // Found it — this view-entry's one-time decision is made right here,
  // regardless of the outcome below. Nothing after this point should ever
  // run again until the next hashchange resets the flag.
  appliedThisView = true;

  if (select.value === "100") return; // already 100 — nothing to change, nothing to dispatch

  select.value = "100";
  select.dispatchEvent(new Event("change", { bubbles: true }));
}

window.addEventListener("hashchange", () => {
  appliedThisView = false;
});

setInterval(applyDefaultPageSize, 600);
setTimeout(applyDefaultPageSize, 800);
