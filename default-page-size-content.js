"use strict";

// ═══════════════════════════════════════════════════════════════════════
// DEFAULT "ITEMS PER PAGE" TO 100 — content script side
// ═══════════════════════════════════════════════════════════════════════
// Gated on a single on/off toggle in the side panel's Settings drawer
// (defaultPageSizeEnabled in chrome.storage.local, defaulting to true so
// existing behavior is preserved for anyone who hasn't touched it — see
// dpPageSizeToggle in sidepanel.js). When on, finds the Photo Requests
// list view's own "items per page" dropdown and keeps it pinned to 100,
// dispatching a real change event so the CRM's own logic picks it up and
// re-fetches the list — same idea as auto-all-click-content.js's approach
// to triggering the CRM's own UI programmatically rather than
// reimplementing its pagination logic here. When off, this does nothing
// at all — doesn't even look at the dropdown — leaving the CRM's native
// pagination behavior exactly as if this script weren't here.
//
// v1 (PAGESIZE-01) only reapplied once per hashchange/navigation into the
// list view, on the theory that the dropdown only ever resets on a real
// page navigation. That missed a real case: clicking a status filter tab
// (All/Pending/etc.) is a client-side re-render, not a hashchange — it
// silently resets the CRM's own <select> back to its native default (10)
// without ever firing a hashchange, so the old one-shot "already applied"
// flag stayed set and never noticed. Fixed here by watching the select's
// actual value continuously — the same polling-interval pattern already
// used elsewhere in this codebase (e.g. quick-copy-content.js) — instead
// of a one-shot flag: every tick (while enabled), if the observed value
// has drifted away from 100 AND that drift wasn't a genuine, direct user
// pick (see userJustPickedManually below), it gets reapplied.
//
// Distinguishing "the CRM silently reset it" from "the person actually
// picked something else" matters — manual overrides during a session are
// still meant to be respected, exactly as in v1. The signal used for that
// is the select's native `input` event: a real user pick fires both
// `input` and `change` on a <select>, but setting `.value` from script and
// manually dispatching only `change` — which is exactly what this file's
// own reapplication does below, and all it needs to for the CRM's own
// logic to pick it up — never fires `input`. So `input` is an unambiguous
// "a person, not this script, just touched this dropdown" signal, immune
// to catching this script's own writes. userJustPickedManually persists
// for the rest of the view-entry once set (same "session" scope as v1's
// flag) — a later CRM re-render is free to reset the select's own value
// again after that, but this script won't fight it back once someone has
// deliberately chosen something else.
let enabled = true;
let userJustPickedManually = false;

chrome.storage.local.get(["defaultPageSizeEnabled"], result => {
  enabled = result && result.defaultPageSizeEnabled !== false;
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.defaultPageSizeEnabled) {
    enabled = changes.defaultPageSizeEnabled.newValue !== false;
  }
});

function findPerPageSelect() {
  const container = document.querySelector(".dds__pagination__per-page-select");
  return container ? container.querySelector("select") : null;
}

// Tracked by reference, not just "has a listener ever been bound" — a
// filter-tab click can swap in a brand-new <select> element entirely
// rather than mutating the old one's value, and a listener bound to the
// old (now-detached) element would never fire again.
let boundSelect = null;

function bindManualOverrideListener(select) {
  if (boundSelect === select) return;
  boundSelect = select;
  select.addEventListener("input", () => {
    userJustPickedManually = true;
  });
}

function reassertDefaultPageSize() {
  if (!enabled) return; // feature turned off — don't touch the DOM at all

  const select = findPerPageSelect();
  if (!select) return; // not on the list view yet, or it hasn't rendered — retry next tick

  bindManualOverrideListener(select);

  if (userJustPickedManually) return; // respecting the person's own choice for this view-entry

  if (select.value === "100") return; // already 100 — nothing to change, nothing to dispatch

  select.value = "100";
  select.dispatchEvent(new Event("change", { bubbles: true }));
}

window.addEventListener("hashchange", () => {
  userJustPickedManually = false;
  boundSelect = null;
});

setInterval(reassertDefaultPageSize, 600);
setTimeout(reassertDefaultPageSize, 800);
