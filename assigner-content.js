(function () {
  "use strict";

  // Loaded from storage at init — background.js for each version sets this.
  let ROLE = "senior"; // "senior" | "junior"
  let MY_NAME = "";    // junior only — the logged-in editor's name

  // Direct sheet access — used by the history modal so it doesn't depend on
  // the background service worker being awake. Keep in sync with background.js.
  const SHEET_URL   = "https://script.google.com/a/macros/drivenproperties.com/s/AKfycbxRnU165B4OZoIyc-sDFrkQB-tePNsb9MBrMWJa7IRZuTWzzITQvxT6ES7eSCVzc6S-/exec";
  const SHEET_TOKEN = "DPPE";

  const EDITORS = ["Harvy", "Jabir", "Mark", "Sudheep"];
  const STATUS_OPTIONS = ["Offplan Pending", "Photos For QC", "Stock Photos For QC", "Upload Pending", "Pending", "Scheduled"];
  // The dashboard/sheet only ever tracks these 3 — they represent a fixed
  // task category (what kind of work the listing needs), not the CRM's
  // live status. Once a listing is first seen in one of these, it's locked
  // in for good and the dashboard ignores everything else (Pending,
  // Scheduled, Completed, etc.) for tracking purposes.
  const CATEGORY_OPTIONS = ["Offplan Pending", "Photos For QC", "Stock Photos For QC", "Upload Pending", "Re-shoot"];
  // Auto-assign is only allowed to fire while the CRM's own live status pill
  // still shows one of these 4 — the genuine "fresh work just landed" states.
  // Deliberately narrower than CATEGORY_OPTIONS: "Re-shoot" is excluded here
  // because that's a derived/internal category assign() itself applies when
  // the CRM shows Completed (see assign()'s own comment on that), not a live
  // CRM status a listing actually sits in — auto-assigning off of it would
  // mean auto-assigning listings the CRM currently shows as Completed, which
  // is exactly the kind of stale/unrelated row this guard exists to exclude.
  const AUTO_ASSIGN_ELIGIBLE_STATUSES = ["Upload Pending", "Offplan Pending", "Photos For QC", "Stock Photos For QC"];
  const BED_BUCKETS = ["0", "1", "2", "3", "4", "5+", "?"];
  const UNASSIGNED_KEY = "";

  // Row border/tint colors per status — reused across every listing row.
  // Set via inline styles (not a stylesheet rule) because the CRM's own
  // CSS sets background-color/box-shadow on .table-row with high enough
  // specificity (and matching values in both light and dark mode) that a
  // plain external rule loses the cascade. Inline `!important` beats any
  // external stylesheet rule regardless of theme, so we set it directly
  // on the element instead of fighting the CRM's selector.
  const ROW_STATUS_COLORS = {
    assigned:   { border: "#e6941a", tint: "rgba(230, 148, 26, 0.10)" },
    inprogress: { border: "#3b82f6", tint: "rgba(59, 130, 246, 0.10)" },
    onhold:     { border: "#b39ddb", tint: "rgba(179, 157, 219, 0.10)" },
    rejected:   { border: "#ef5350", tint: "rgba(239, 83, 80, 0.10)" },
    completed:  { border: "#00d1b2", tint: "rgba(0, 209, 178, 0.10)" },
  };
  // "Unassigned" is a real Status value now stored in the sheet (so history
  // is preserved instead of deleting the row — see unassign()), but for
  // rendering purposes it should behave exactly like "no status yet": show
  // the plain Assign/Hold buttons, not an assigned-looking badge.
  function isActiveStatus(status) { return !!status && status !== "Unassigned"; }
  function rowStatusKey(status) {
    return status === "Assigned"    ? "assigned"   :
           status === "In Progress" ? "inprogress" :
           status === "On Hold"     ? "onhold"     :
           status === "Rejected"    ? "rejected"   :
           status === "Completed"   ? "completed"  : "";
  }
  // ── Round-robin auto-assign ──────────────────────────────────────────────
  // Fully derived from assignmentCache (the shared, sheet-backed source of
  // truth also used for everything else in this file) rather than a
  // separately-persisted counter/rotation-pointer. Two upsides to that:
  //   1. "Resets the next day" is automatic — today's counts are computed
  //      by filtering to today's calendar date every time this runs, so
  //      there's nothing to explicitly clear at midnight.
  //   2. It stays correct across editors/tabs/machines without needing to
  //      sync a rotation pointer between them — everyone computes the same
  //      recommendation from the same shared data.
  //
  // "Today" is judged in each viewer's own local time zone (Date.toDateString
  // on values already normalized to local time), which is what makes a
  // day boundary/reset actually match when the office's day turns over.
  function getAutoAssignRecommendation() {
    const counts = {};
    EDITORS.forEach(e => { counts[e] = 0; });
    // Only editors currently marked eligible (see autoAssignConfig above)
    // are candidates for the recommendation itself — someone off duty
    // today should never be "next up" even if they happen to have the
    // fewest assignments so far (trivially true if they have zero because
    // they haven't worked at all). Counts are still tracked for everyone,
    // though — the popover shows every editor's count today regardless of
    // whether they're currently eligible.
    const eligibleEditors = EDITORS.filter(e => autoAssignConfig[e] !== false);
    const todayStr = new Date().toDateString();
    // Track whichever counted assignment happened most recently today, so
    // ties (most commonly: everyone at 0 first thing in the morning) break
    // by round-robin order continuing on from there, instead of always
    // recommending the same first name in the list all day.
    let lastPicked = null, lastPickedAt = -Infinity;
    Object.keys(assignmentCache).forEach(ref => {
      const entry = assignmentCache[ref];
      if (!entry || !entry.editor || !EDITORS.includes(entry.editor)) return;
      // Whichever is later: the original assign, or the most recent
      // reassignment (which lands this ref on its *current* editor) — both
      // represent the moment this editor picked up this piece of work.
      const effectiveAt = entry.reassignedAt || entry.assignedAt;
      if (!effectiveAt) return;
      const d = new Date(effectiveAt);
      if (isNaN(d.getTime()) || d.toDateString() !== todayStr) return;
      counts[entry.editor] += 1;
      const t = d.getTime();
      if (t >= lastPickedAt) { lastPickedAt = t; lastPicked = entry.editor; }
    });
    if (!eligibleEditors.length) return { next: null, counts };
    const minCount = Math.min(...eligibleEditors.map(e => counts[e]));
    const candidates = eligibleEditors.filter(e => counts[e] === minCount);
    let next = null;
    if (lastPicked) {
      const startIdx = EDITORS.indexOf(lastPicked);
      for (let i = 1; i <= EDITORS.length; i++) {
        const cand = EDITORS[(startIdx + i) % EDITORS.length];
        if (candidates.includes(cand)) { next = cand; break; }
      }
    }
    if (!next) next = candidates[0];
    return { next, counts };
  }

  // Keeps the "Next up" label in the filter bar current. Cheap enough to
  // call on every processRows() pass (a handful of object lookups over
  // assignmentCache, same cost as the recommendation itself) — no-ops
  // harmlessly if the filter bar (senior-only) isn't in the DOM.
  function updateAutoAssignIndicator() {
    const el = document.querySelector(".dp-auto-assign-indicator");
    if (!el) return;
    const { next, counts } = getAutoAssignRecommendation();
    el.textContent = next ? `\u2192 Next up: ${next} (${counts[next] || 0} today)` : "\u2192 No one eligible \u2014 check On duty";
  }

  // Re-syncs the "On duty" popover's checkboxes (if it's been built yet)
  // to match the current autoAssignConfig — called after every fetch that
  // refreshes autoAssignConfig, so a toggle made from another tab/device
  // shows up here too, not just on the tab that made it.
  function syncAutoAssignEligibilityUI() {
    document.querySelectorAll(".dp-eligibility-option").forEach(optLabel => {
      const name = optLabel.dataset.dpEditor;
      const cb = optLabel.querySelector("input[type=checkbox]");
      if (name && cb) cb.checked = autoAssignConfig[name] !== false;
    });
    updateAutoAssignIndicator();
  }

  // Auto-assigns a freshly-appeared Unassigned listing to whoever the
  // round-robin recommendation currently favors, when the toggle is on.
  // Only ever fires for senior (matches assign()'s own access rule) and
  // only once armed (see autoAssignArmed above). Reuses the exact same
  // assign() codepath a senior clicking a popover option would hit —
  // optimistic local update, write to the Sheet, verify-before-reverting
  // on a flaky response — via the __dpAssign hook renderAssignCell exposes.
  function maybeAutoAssign(ref, cell, crmStatus) {
    if (!autoAssignEnabled || !autoAssignArmed) return;
    if (ROLE !== "senior" || !MY_NAME) return;
    if (!ref || !cell || typeof cell.__dpAssign !== "function") return;
    if (!AUTO_ASSIGN_ELIGIBLE_STATUSES.includes(crmStatus)) return; // not fresh incoming work
    const entry = assignmentCache[ref];
    if (entry && isActiveStatus(entry.status)) return; // already spoken for
    if (autoAssignInFlight.has(ref)) return;
    autoAssignInFlight.add(ref);
    // With more than one senior tab/machine watching the same board, two
    // tabs can both notice the same brand-new Unassigned listing within
    // the same instant and each independently decide to auto-assign it —
    // there's no shared lock between separate browser sessions. A short
    // randomized delay, plus a fresh eligibility check right before the
    // write actually fires, staggers that: whichever tab's poll or DOM
    // update reflects the other tab's assignment first will see this ref
    // is no longer eligible and quietly back off, instead of both writing
    // to the same ref at once. Doesn't make the race impossible (that
    // would need a real server-side lock across tabs), but makes it very
    // unlikely in practice, and any write that does still race is caught
    // by the normal poll-and-converge behavior everything else here
    // already relies on.
    const jitterMs = 300 + Math.floor(Math.random() * 1500);
    setTimeout(() => {
      const fresh = assignmentCache[ref];
      const stillEligible = !fresh || !isActiveStatus(fresh.status);
      // Re-check the CRM status guard too, not just at call time — the
      // jitter delay above means the row's live status could have moved on
      // (e.g. someone actioned it manually, or it fell out of the tracked
      // categories) in the time between when this was first noticed and
      // when the write is actually about to fire.
      const parentRow = cell.closest(".table-row.accordion");
      const liveCrmStatus = (parentRow && parentRow.dataset.dpCrmStatus) || crmStatus;
      if (stillEligible && AUTO_ASSIGN_ELIGIBLE_STATUSES.includes(liveCrmStatus)) {
        const { next } = getAutoAssignRecommendation();
        if (next) cell.__dpAssign(next, { isAutoAssign: true });
      }
      // assign() (when it fires) is fire-and-forget from here — it already
      // handles its own retry/revert internally. Either way, stop treating
      // the ref as in-flight after a reasonable window so a genuinely
      // failed+reverted auto-assign can be retried on a later pass instead
      // of being stuck "in flight" forever.
      setTimeout(() => autoAssignInFlight.delete(ref), 15000);
    }, jitterMs);
  }

  const PROCESS_DEBOUNCE_MS = 150;
  // Real-time mode: as fast as we can safely poll Apps Script (which is now
  // fully uncached on this endpoint — see appscript.js) without tripping its
  // execution/URL-fetch quotas across every editor + dashboard tab polling
  // at once. 3s is the active-tab rate; BACKGROUND_REFRESH_INTERVAL_MS below
  // backs off automatically for tabs that aren't currently visible, which is
  // what buys the headroom to poll this tight in the first place.
  const REFRESH_INTERVAL_MS = 3000;
  const BACKGROUND_REFRESH_INTERVAL_MS = 15000;
  const BURST_WINDOW_MS = 2000;
  const BURST_THRESHOLD = 25;
  const BURST_DEBOUNCE_MS = 800;

  let assignmentCache = {};
  let downloadedCache = {};
  let lastLocalChangeAt = {};
  let refreshInFlight = false;
  let selectedBedroomFilters = new Set();
  let selectedEditorFilters = new Set();
  let selectedStatusFilters = new Set();
  let filterBarInjected = false;
  // When on, clicking a listing row opens that listing in a brand-new
  // browser tab (searched there by ref number) and moves focus to it,
  // instead of opening the drawer in this same tab. Defaults to on;
  // persisted in chrome.storage.local so the choice sticks across page
  // loads/tabs.
  let openListingInNewTabEnabled = false;
  // Round-robin auto-assign — see the "── Round-robin auto-assign ──"
  // section below for the recommendation/assignment logic itself.
  let autoAssignEnabled = false;
  // Stays false until the very first Apps Script fetch has come back and
  // been rendered once. Without this, turning the toggle on would, on
  // page load, treat every listing that's been sitting Unassigned for
  // days as "brand new" and auto-assign the entire backlog in one burst
  // the instant the page opens. Flips to true right after that first
  // render and stays true for the rest of the tab's life — every listing
  // that shows up as newly-Unassigned from that point on is genuinely new.
  let autoAssignArmed = false;
  let autoAssignArmDone = false;
  // "Who's on duty" — { editorName: true/false }, sourced from the
  // AutoAssignConfig sheet tab (see readAutoAssignConfig on the Apps
  // Script side) and refreshed alongside every regular assignment fetch.
  // An editor with no entry here at all defaults to eligible, matching
  // the server's own default — see getAutoAssignRecommendation below for
  // where this actually gets applied.
  let autoAssignConfig = {};
  // Refs currently mid-flight through an auto-triggered assign() call —
  // prevents the same ref from being auto-assigned a second time by a poll
  // that lands while the first attempt's write (and its verify-before-
  // reverting retries) is still in progress.
  const autoAssignInFlight = new Set();
  let processTimer = null;
  let pollHandle = null;
  let contextDead = false;
  let origIndexCounter = 0;
  let currentSort = null;
  let mutationBurstCount = 0;
  let mutationBurstWindowStart = 0;

  // ── Context invalidation guards ──────────────────────────────────────────
  function extensionAlive() {
    try { return !!(chrome && chrome.runtime && chrome.runtime.id); }
    catch (e) { return false; }
  }
  function handleContextInvalidated() {
    if (contextDead) return;
    contextDead = true;
    try { observer.disconnect(); } catch (e) {}
    if (pollHandle) clearInterval(pollHandle);
    try { hideFlickerShield(); } catch (e) {}
    console.log("DP Photo Request Assigner: extension reloaded — refresh this page.");
  }
  function isContextError(e) {
    return /Extension context invalidated/i.test((e && (e.message || String(e))) || "");
  }
  function guarded(fn) {
    return function (...args) {
      if (contextDead) return;
      try { return fn.apply(this, args); }
      catch (e) { if (isContextError(e)) handleContextInvalidated(); else throw e; }
    };
  }
  function safeSendMessage(message, callback) {
    if (!extensionAlive()) { handleContextInvalidated(); return; }
    try { chrome.runtime.sendMessage(message, callback); }
    catch (e) { handleContextInvalidated(); }
  }

  // Shared by every write action below. Confirmed real behavior (not a
  // guess): Apps Script's write itself can succeed correctly while the
  // HTTP response delivery back to the browser still flakes (e.g.
  // returning an HTML page instead of the expected JSON) — so a "failed"
  // response here does NOT reliably mean the write didn't happen. Reverting
  // and alerting immediately, as every write action used to do, produces
  // exactly the reported symptom: revert + alert, even though the Sheet
  // already has the correct value, self-correcting a few seconds later
  // once the next poll catches up.
  //
  // A SINGLE immediate recheck isn't enough on its own: the server's write
  // lock can legitimately still be holding the actual write seconds after
  // the client already gave up (aborting client-side does not cancel the
  // request server-side — it keeps running to completion regardless). A
  // recheck fired the instant the timeout fires can catch that write mid-
  // flight, correctly see the OLD value in that exact moment, and revert
  // anyway — which is a false negative on timing, not a real failure. So
  // this retries a few times with a short gap before giving up, giving a
  // slow-but-real write room to land instead of declaring failure on the
  // first snapshot that happens to be too early.
  const VERIFY_MAX_ATTEMPTS = 4;   // 1 immediate + 3 retries
  const VERIFY_RETRY_DELAY_MS = 3000; // ~9s of extra patience beyond the immediate check
  function verifyBeforeReverting(ref, expectedStatusOrPredicate, doRevert, failureMessage, attempt = 0) {
    const matches = typeof expectedStatusOrPredicate === "function"
      ? expectedStatusOrPredicate
      : m => m.status === expectedStatusOrPredicate;

    safeSendMessage({ type: "DP_GET_ALL" }, verifyResp => {
      // .filter().pop() rather than .find() — a Ref can now have more than
      // one row (see reopenOnCategoryChange server-side), and rows are
      // always appended after the ones they follow, so the last match is
      // always the current cycle. .find() would silently grab whichever
      // occurrence came first — an old Rejected/Completed row from a prior
      // cycle — and this verification check would then compare against the
      // wrong row's status entirely.
      const match = verifyResp && verifyResp.ok && verifyResp.data && Array.isArray(verifyResp.data.assignments)
        ? verifyResp.data.assignments.filter(a => a.ref === ref).pop()
        : null;

      if (match && matches(match)) {
        // It actually went through — the earlier "failure" was in the
        // response delivery (or a slow-but-real write), not the write
        // itself. Sync to the now-confirmed truth and leave the UI as-is;
        // no revert, no alert.
        assignmentCache[ref] = {
          editor: match.editor || "", status: match.status || "", title: match.title || "",
          assignedAt: match.assignedAt || "", startedAt: match.startedAt || "",
          completedAt: match.completedAt || "", rejectedAt: match.rejectedAt || "",
          onHoldAt: match.onHoldAt || "", onHoldReason: match.onHoldReason || "",
          assignedBy: match.assignedBy || "", reassignedFrom: match.reassignedFrom || "",
          reassignedTo: match.reassignedTo || "", reassignedBy: match.reassignedBy || "",
          reassignedAt: match.reassignedAt || "", bedrooms: match.bedrooms || "",
          crmStatus: match.crmStatus || "", downloadedAt: match.downloadedAt || "",
          history: Array.isArray(match.history) ? match.history : [],
          listingRef: match.listingRef || "",
        };
        if (match.downloaded) downloadedCache[ref] = true; else delete downloadedCache[ref];
        lastLocalChangeAt[ref] = Date.now();
        processRows();
        return;
      }

      if (attempt < VERIFY_MAX_ATTEMPTS - 1) {
        // Still not confirmed — the write may just not have landed yet.
        // Wait a beat and check again rather than giving up on this snapshot.
        setTimeout(guarded(() =>
          verifyBeforeReverting(ref, expectedStatusOrPredicate, doRevert, failureMessage, attempt + 1)
        ), VERIFY_RETRY_DELAY_MS);
        return;
      }

      // Genuinely didn't happen after every retry — now actually revert and say so.
      doRevert();
      alert(failureMessage);
    });
  }

  // Bottom-right confirmation toast — same fixed position/fade timing as
  // identity-guard.js's name-warning toast, but in the extension's teal
  // "success" palette rather than red, used to confirm clipboard copies.
  function showCopyToast(message) {
    const existing = document.getElementById("dp-copy-toast");
    if (existing) existing.remove();

    const toast = document.createElement("div");
    toast.id = "dp-copy-toast";
    toast.textContent = `\u2713 ${message}`;

    Object.assign(toast.style, {
      position: "fixed", bottom: "20px", right: "30px",
      background: "#0f2e29", color: "#5eead4",
      border: "1px solid rgba(0,209,178,0.4)",
      padding: "12px 16px", borderRadius: "8px",
      fontWeight: "600", fontSize: "13px", lineHeight: "1.4",
      zIndex: "2147483647", maxWidth: "320px",
      boxShadow: "0 6px 20px rgba(0,0,0,.45)",
      opacity: "0", transform: "translateY(12px)",
      transition: "opacity .25s ease-out, transform .25s ease-out",
      fontFamily: "-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif",
      pointerEvents: "none",
    });

    document.body.appendChild(toast);
    requestAnimationFrame(() => {
      toast.style.opacity = "1";
      toast.style.transform = "translateY(0)";
    });
    setTimeout(() => {
      toast.style.opacity = "0";
      toast.style.transform = "translateY(12px)";
    }, 2200);
    setTimeout(() => toast.remove(), 2600);
  }

  // NOTE: a persistent "still loading" / "couldn't load" status banner used
  // to live here (shown from refreshAssignments below on a slow/failed
  // fetch). Removed per request — it was more annoying than useful. The
  // slow-load timer and failure logging in refreshAssignments stay in
  // place (still useful in the console), they just no longer pop anything
  // up on screen.


  // ── Flicker shield ───────────────────────────────────────────────────────
  // Used by the "Open in new tab" row-click feature: we have to let the CRM
  // briefly open the real drawer in this tab to learn its unique URL (see
  // captureDrawerUrlThenDuplicate below), then close it again. Left alone,
  // that's a visible open/close flash. This shield is a full-viewport div,
  // color-matched to whatever's on screen right now (so it reads as a
  // frozen frame rather than a color mismatch), dropped in synchronously
  // in the same click tick — before the native click even reaches the
  // CRM's own handler — so the drawer never gets a chance to paint under
  // it. No fade in/out on purpose: the goal is an instant freeze/unfreeze,
  // not a visible transition.
  function showFlickerShield() {
    let shield = document.getElementById("dp-flicker-shield");
    if (shield) return shield;
    shield = document.createElement("div");
    shield.id = "dp-flicker-shield";
    Object.assign(shield.style, {
      position: "fixed", inset: "0",
      background: getComputedStyle(document.body).backgroundColor || "#10131c",
      zIndex: "2147483646", // one below the toast/banner's max z-index
      cursor: "progress",
    });
    document.documentElement.appendChild(shield);
    return shield;
  }
  function hideFlickerShield() {
    const shield = document.getElementById("dp-flicker-shield");
    if (shield) shield.remove();
  }

  // ── Auto-search (dashboard ref → CRM search box) ─────────────────────────
  // This same content script is also injected on the CRM's own
  // /photorequest/requests search page (it matches the whole /photorequest/*
  // path), so it's the right place to listen for a "fill the search box and
  // hit search" instruction sent from background.js after a dashboard ref
  // is clicked — no separate script/page needed.
  function fillAndTriggerCrmSearch(ref) {
    const input = document.querySelector('.outer-search input.input[placeholder="Photo Request Search..."]');
    if (!input) throw new Error("Search box not found on this page.");

    const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    input.focus();
    // Use the native setter rather than plain assignment so frameworks that
    // patch the value property (React-style) still see the change — this
    // is harmless for a plain Vue v-model input too, which just reads the
    // DOM value once the input event fires below.
    nativeSetter.call(input, ref);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));

    const searchIcon = document.querySelector(".outer-search .suffix-icon");
    if (searchIcon) {
      searchIcon.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    } else {
      // Fallback if the icon markup ever changes: press Enter in the box.
      ["keydown", "keyup"].forEach(type => input.dispatchEvent(
        new KeyboardEvent(type, { key: "Enter", code: "Enter", bubbles: true })
      ));
    }
  }

  if (chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message && message.type === "DP_FILL_SEARCH") {
        try {
          fillAndTriggerCrmSearch(message.ref);
          sendResponse({ ok: true });
        } catch (err) {
          sendResponse({ ok: false, error: String(err && err.message || err) });
        }
        return true;
      }
    });
  }

  // "Open in new tab" and "Auto-assign" are now toggled from the side
  // panel's Settings drawer rather than from a control rendered on this
  // page (see the removed Configuration filter-bar section above) — this
  // is what makes flipping either of them take effect in an already-open
  // CRM tab immediately, instead of only on the next reload.
  if (chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      if (changes.dpOpenListingNewTab) {
        openListingInNewTabEnabled = changes.dpOpenListingNewTab.newValue === true;
      }
      if (changes.dpAutoAssignEnabled) {
        autoAssignEnabled = changes.dpAutoAssignEnabled.newValue === true;
      }
    });
  }

  // ── Scroll preservation ──────────────────────────────────────────────────
  function preserveScrollAround(actionFn) {
    const x = window.scrollX, y = window.scrollY;
    const restore = () => {
      if (window.scrollX !== x || window.scrollY !== y) window.scrollTo(x, y);
    };
    actionFn();
    // Fire immediately after the next two paint frames (catches same-tick reflows)
    requestAnimationFrame(() => requestAnimationFrame(restore));
    // Each subsequent restore is wrapped in rAF so it fires *after* any layout
    // the browser deferred to that tick — plain setTimeout can fire before the
    // reflow that the preceding DOM mutations triggered, so the position check
    // sees no change yet and silently does nothing.
    [50, 200, PROCESS_DEBOUNCE_MS + 60, PROCESS_DEBOUNCE_MS + 250,
     BURST_DEBOUNCE_MS + 60, 1000].forEach(ms =>
      setTimeout(() => requestAnimationFrame(restore), ms)
    );
  }

  // ── Debounce + burst guard ───────────────────────────────────────────────
  function debounceProcess() {
    if (contextDead) return;
    const now = Date.now();
    if (now - mutationBurstWindowStart > BURST_WINDOW_MS) {
      mutationBurstWindowStart = now;
      mutationBurstCount = 0;
    }
    mutationBurstCount++;
    const inBurst = mutationBurstCount > BURST_THRESHOLD;
    clearTimeout(processTimer);
    processTimer = setTimeout(guarded(() => {
      processRows();
      ensureFilterBar();
      ensureDrawerCompleteButton();
    }), inBurst ? BURST_DEBOUNCE_MS : PROCESS_DEBOUNCE_MS);
  }

  // ── DOM helpers ──────────────────────────────────────────────────────────
  function getAllRows() {
    return Array.from(document.querySelectorAll(".table-row.accordion"));
  }
  function extractRef(row) {
    const cells = row.querySelectorAll(
      ".table-cell.has-label-mobile.price.has-text-left.mobile-res-style.lead-tab"
    );
    for (const cell of cells) {
      if (cell.classList.contains("req_class")) continue;
      const label = cell.querySelector("label");
      if (label && label.textContent.trim() === "Ref") {
        const span = cell.querySelector("span[data-tooltip]");
        if (span) return (span.getAttribute("data-tooltip") || span.textContent || "").trim();
      }
    }
    return null;
  }
  function extractBedrooms(row) {
    const columns = row.querySelectorAll(".beds_baths .preview-icon-list-column");
    for (const col of columns) {
      const labelSpan = col.querySelector(".is-size-8.has-text-grey");
      if (labelSpan && labelSpan.textContent.trim() === "Bedrooms") {
        const numSpan = col.querySelector(".has-text-weight-bold");
        if (numSpan) {
          const raw = numSpan.textContent.trim();
          if (/studio/i.test(raw)) return 0;
          const n = parseInt(raw, 10);
          return Number.isNaN(n) ? null : n;
        }
      }
    }
    return null;
  }
  function extractTitle(row) {
    const el = row.querySelector(".title-text");
    return el ? el.textContent.trim() : "";
  }
  // Matches the CRM's listing-reference badge (e.g. "DP-S-49080") — kept
  // strict against a known prefix list rather than accepting any text in a
  // ".badge.ref" element, since that class combo isn't guaranteed unique to
  // this one badge across every CRM page layout. A stray unrelated match
  // here would otherwise silently pollute the persisted ListingRef field.
  const LISTING_REF_PATTERN = /^(?:DPA-[SR]-|DP-[SR]-|CBB-[SR]-|[SR]-)\d+/i;
  function extractReferenceCode(row) {
    const el = row.querySelector(".badge.ref");
    const text = el ? el.textContent.trim() : "";
    return text && LISTING_REF_PATTERN.test(text) ? text : null;
  }
  // Some CRM status values are just an "approved" follow-on state of one
  // of our tracked categories, not a genuinely different category — e.g.
  // once QC approves what was submitted as "Photos For QC", the CRM's own
  // badge changes to "QC Approved". Left unmapped, these fall outside
  // CATEGORY_OPTIONS entirely and get silently ignored everywhere that
  // cares about category (syncMeta write-once tracking, reopen-on-
  // recategorize) — normalizing them here, at the single source every
  // caller reads from, means every one of those benefits without needing
  // its own mapping.
  const CRM_STATUS_ALIASES = {
    "QC Approved": "Photos For QC",
    "Stock Photos QC Approved": "Stock Photos For QC",
  };

  // Reads the CRM's own listing status pill (e.g. "Offplan Pending",
  // "Photos For QC", "Upload Pending", "Pending", "Scheduled") — this is
  // separate from our extension's Assign/Hold/Complete tracking status.
  function extractCrmStatus(row) {
    const cells = row.querySelectorAll(".table-cell");
    for (const cell of cells) {
      const label = cell.querySelector("label");
      if (label && label.textContent.trim() === "Status") {
        const badge = cell.querySelector(".m-badge, [class*='badge']");
        const raw = badge ? badge.textContent.trim() : cell.textContent.replace(label.textContent, "").trim();
        if (!raw) return null;
        return CRM_STATUS_ALIASES[raw] || raw;
      }
    }
    return null;
  }
  function bedroomBucket(n) {
    if (n === null || n === undefined) return null;
    return n >= 5 ? "5+" : String(n);
  }
  function bedroomChipLabel(val) { return val === "0" ? "Studio" : val === "?" ? "Unknown" : val; }

  function closeAllPopovers(except) {
    document.querySelectorAll(".dp-popover.is-open").forEach(p => {
      if (p !== except) p.classList.remove("is-open");
    });
  }

  // ── Assign cell ──────────────────────────────────────────────────────────
  function renderAssignCell(ref, title, refCode) {
    const cell = document.createElement("div");
    cell.className = "table-cell dp-assign-cell";
    cell.dataset.dpRef = ref || "";

    const labelEl = document.createElement("label");
    labelEl.textContent = "Assignment";
    cell.appendChild(labelEl);

    // Outer column wrapper
    const widgetRow = document.createElement("div");
    widgetRow.className = "dp-assign-widget-row";
    cell.appendChild(widgetRow);

    // Action row: status widget + drive + history all inline, no wrap
    const actionRow = document.createElement("div");
    actionRow.className = "dp-action-row";
    widgetRow.appendChild(actionRow);

    // Status widget (badge / assign button)
    const widget = document.createElement("div");
    widget.className = "dp-assign-widget";
    actionRow.appendChild(widget);

    // Icon button group — drive search + history + copy-ref live together
    // in one wrapper so flex-wrap moves them as a single unit. Without
    // this, .dp-action-row's wrap could break the trio apart individually
    // (e.g. copy dropping to its own line while drive+history stay put).
    const iconGroup = document.createElement("div");
    iconGroup.className = "dp-icon-btn-group";
    actionRow.appendChild(iconGroup);

    // Drive search button — sits beside the status widget
    if (refCode) {
      const driveBtn = document.createElement("button");
      driveBtn.type = "button";
      driveBtn.className = "dp-drive-btn";
      driveBtn.title = `Find ${refCode} in Google Drive`;
      driveBtn.innerHTML = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2z"></path><circle cx="11" cy="13" r="2.5"></circle><path d="m17 18 2.5 2.5"></path></svg>';
      driveBtn.addEventListener("click", e => {
        e.stopPropagation();
        safeSendMessage({ type: "DP_OPEN_DRIVE_SEARCH", query: refCode }, resp => {
          if (!(resp && resp.ok)) console.log("DP Drive search failed", resp);
        });
      });
      iconGroup.appendChild(driveBtn);
    }

    // History icon button — re-extracts the DP-REQ ref from the live row
    // DOM at click time so it's always the correct search key, even if
    // extractRef returned null when the cell was first injected.
    const historyBtn = document.createElement("button");
    historyBtn.type = "button";
    historyBtn.className = "dp-history-btn";
    historyBtn.title = "View time history for this listing";
    historyBtn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>';
    historyBtn.addEventListener("click", e => {
      e.stopPropagation();
      // Walk up to the accordion row and re-extract the DP-REQ number live
      const row = historyBtn.closest(".table-row.accordion");
      const liveRef = (row ? extractRef(row) : null) || ref;
      showHistoryModal(liveRef, refCode, title);
    });
    iconGroup.appendChild(historyBtn);

    // Copy-ref button — copies just the DP-REQ number for this listing,
    // re-extracted live at click time the same way the history button
    // does, so it's always correct even if the row's DOM shifted around.
    const copyRefBtn = document.createElement("button");
    copyRefBtn.type = "button";
    copyRefBtn.className = "dp-copyref-btn";
    copyRefBtn.title = "Copy reference number";
    copyRefBtn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>';
    copyRefBtn.addEventListener("click", e => {
      e.stopPropagation();
      const row = copyRefBtn.closest(".table-row.accordion");
      const liveRef = (row ? extractRef(row) : null) || ref;
      if (!liveRef) return;
      navigator.clipboard.writeText(liveRef).then(() => {
        const prevTitle = copyRefBtn.title;
        copyRefBtn.classList.add("is-copied");
        copyRefBtn.title = "Copied!";
        showCopyToast(`Copied to clipboard: ${liveRef}`);
        setTimeout(() => {
          copyRefBtn.classList.remove("is-copied");
          copyRefBtn.title = prevTitle;
        }, 1200);
      }).catch(() => {});
    });
    iconGroup.appendChild(copyRefBtn);

    // Downloaded checkbox — on its own row below the action row
    const downloadedLabel = document.createElement("label");
    downloadedLabel.className = "dp-downloaded-wrap";
    downloadedLabel.title = "Mark as downloaded from Drive";
    const downloadedCheckbox = document.createElement("input");
    downloadedCheckbox.type = "checkbox";
    downloadedCheckbox.className = "dp-downloaded-checkbox";
    downloadedCheckbox.checked = !!(ref && downloadedCache[ref]);
    downloadedCheckbox.addEventListener("click", e => {
      e.stopPropagation();
      if (!window.dpRequireName()) e.preventDefault();
    });
    downloadedCheckbox.addEventListener("change", () => {
      if (!ref) return;
      preserveScrollAround(() => {
        const val = downloadedCheckbox.checked;
        const wasSet = !!downloadedCache[ref];
        if (val) downloadedCache[ref] = true; else delete downloadedCache[ref];
        lastLocalChangeAt[ref] = Date.now();
        cell.dataset.dpDownloaded = val ? "1" : "0";
        // Only stamp a time when turning it ON — unchecking clears the flag
        // but shouldn't erase when it was originally downloaded, so we send
        // an empty string and let the sheet decide whether to keep it.
        const downloadedAt = val ? new Date().toISOString() : "";
        safeSendMessage({ type: "DP_SET_DOWNLOADED", ref, downloaded: val, downloadedAt, title }, resp => {
          if (!(resp && resp.ok)) {
            verifyBeforeReverting(ref, m => !!m.downloaded === val, () => {
              if (wasSet) downloadedCache[ref] = true; else delete downloadedCache[ref];
              lastLocalChangeAt[ref] = Date.now();
              cell.dataset.dpDownloaded = wasSet ? "1" : "0";
              downloadedCheckbox.checked = wasSet;
            }, "Could not save downloaded status — reverted.");
          }
        });
      });
    });
    const downloadedText = document.createElement("span");
    downloadedText.textContent = "Downloaded";
    downloadedLabel.appendChild(downloadedCheckbox);
    downloadedLabel.appendChild(downloadedText);
    widgetRow.appendChild(downloadedLabel);
    cell.dataset.dpDownloaded = downloadedCheckbox.checked ? "1" : "0";
    cell.__dpSetDownloadedChecked = val => { downloadedCheckbox.checked = !!val; };

    // ── Role-specific status UI ──────────────────────────────────────────
    function renderBadge(editor, status) {
      const isCompleted = status === "Completed";
      const isAssigned  = status === "Assigned";
      const isOnHold    = status === "On Hold";
      const isRejected  = status === "Rejected";
      const badge = document.createElement("div");
      badge.className = "dp-assigned-badge" +
        (isCompleted ? " is-completed" :
         isAssigned  ? " is-assigned"  :
         isOnHold    ? " is-on-hold"   :
         isRejected  ? " is-rejected"  : "");
      badge.title = ((ROLE === "senior" || ROLE === "junior") && !isRejected) ? "Click to reassign" :
        (ROLE === "senior" && isRejected) ? "Click \u00D7 to move back to Unassigned" : "";

      const statusSpan = document.createElement("span");
      statusSpan.className = "dp-badge-status";
      statusSpan.textContent = status || "Assigned";
      badge.appendChild(statusSpan);

      const editorSpan = document.createElement("span");
      editorSpan.className = "dp-badge-editor";
      editorSpan.textContent = editor || "Unassigned";
      badge.appendChild(editorSpan);

      // Senior: click badge to reassign, × to unassign.
      // Junior: click badge to reassign too — but no × unassign button,
      // and no way to make a fresh assignment on an Unassigned listing
      // (see renderUnassigned) — reassigning an existing assignment is as
      // far as junior access goes.
      if ((ROLE === "senior" || ROLE === "junior") && !isRejected) {
        if (ROLE === "senior") {
          const closeBtn = document.createElement("button");
          closeBtn.type = "button";
          closeBtn.className = "dp-unassign-btn";
          closeBtn.title = "Unassign";
          closeBtn.textContent = "\u00D7";
          closeBtn.addEventListener("click", e => { e.stopPropagation(); unassign(); });
          badge.appendChild(closeBtn);
        }
        badge.addEventListener("click", e => { e.stopPropagation(); openPopover(); });
      } else if (ROLE === "senior" && isRejected) {
        // Rejected listings don't support click-to-reassign (the badge
        // click is a no-op here) — but a senior can still move one back
        // to Unassigned via the × button, same as any other status.
        const closeBtn = document.createElement("button");
        closeBtn.type = "button";
        closeBtn.className = "dp-unassign-btn";
        closeBtn.title = "Move back to Unassigned";
        closeBtn.textContent = "\u00D7";
        closeBtn.addEventListener("click", e => { e.stopPropagation(); unassign(); });
        badge.appendChild(closeBtn);
        badge.addEventListener("click", e => e.stopPropagation());
      } else {
        badge.addEventListener("click", e => e.stopPropagation());
      }
      return badge;
    }

    // Keeps the outer listing row's border/tint in sync with its status.
    // Called from both render paths below rather than at every individual
    // assign/reject/hold call site, since those all funnel through
    // renderAssigned/renderUnassigned anyway.
    //
    // Reads status from cell.dataset.dpAppliedStatus (always set by the
    // caller immediately before this runs — see every assign/hold/reject/
    // markInProgress site) rather than taking it as an argument, so this
    // same function can double as an idempotent "healer": the CRM appears
    // to be React-based, and editing something elsewhere on an expanded
    // row (e.g. the Photo Gallery) can trigger React to re-render that
    // row's DOM and silently wipe the inline style/background we forced
    // onto it — without adding/removing any nodes, which means the
    // childList-only MutationObserver below never even notices. Re-running
    // this on a timer (see the 800ms poll near init) re-heals that even
    // though we can't hook the actual React re-render directly.
    function applyRowStatusStyle() {
      const row = cell.closest(".table-row.accordion");
      if (!row) return;
      const key = rowStatusKey(cell.dataset.dpAppliedStatus || "");
      const colors = ROW_STATUS_COLORS[key];

      if (colors) {
        // Box-shadow (not the `border` property), so it never affects the
        // row's box model/layout — a left-side accent stripe only.
        row.style.setProperty("box-shadow", `inset 4px 0 0 0 ${colors.border}`, "important");
        row.style.setProperty("background-color", colors.tint, "important");
        row.dataset.dpRowStatus = key;
      } else {
        row.style.removeProperty("box-shadow");
        row.style.removeProperty("background-color");
        delete row.dataset.dpRowStatus;
      }

      // The accordion row's expanded detail view (Photo Request Details,
      // Notes, Recent Activities, etc.) renders each section as its own
      // .preview-body-wrap card, with .preview-body-header as the title
      // strip inside it — both set an opaque background-color !important
      // in the CRM's own CSS, so like the row itself these need inline
      // !important to win. No-op (empty querySelectorAll) on collapsed
      // rows, so running it unconditionally isn't a real cost.
      const cards = row.querySelectorAll(".preview-body-wrap, .preview-body-header");
      cards.forEach(card => {
        if (colors) card.style.setProperty("background-color", colors.tint, "important");
        else card.style.removeProperty("background-color");
      });
    }
    cell.__dpReassertVisuals = applyRowStatusStyle;

    // The accordion row's expanded detail view (Photo Request Details,
    // Notes, Recent Activities, etc.) renders each section as its own
    // .preview-body-wrap card, with .preview-body-header as the title
    // strip inside it — both set an opaque background-color !important in
    // the CRM's own CSS, so like the row itself these need inline
    // !important to win. These cards only exist in the DOM once the row
    // is expanded — handled above inside applyRowStatusStyle now.

    function renderUnassigned() {
      applyRowStatusStyle();
      widget.innerHTML = "";
      if (ROLE === "senior") {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "dp-assign-btn";
        btn.textContent = "Assign";
        btn.addEventListener("click", e => { e.stopPropagation(); openPopover(); });
        widget.appendChild(btn);

        const holdBtn = document.createElement("button");
        holdBtn.type = "button";
        holdBtn.className = "dp-hold-btn";
        holdBtn.textContent = "Hold";
        holdBtn.title = "Put on hold with reason";
        holdBtn.addEventListener("click", e => {
          e.stopPropagation();
          showOnHoldModal("", "edit", reason => setOnHold(reason));
        });
        widget.appendChild(holdBtn);
      } else {
        const dash = document.createElement("span");
        dash.className = "dp-unassigned-pill";
        dash.textContent = "Unassigned";
        widget.appendChild(dash);

        // Junior can still put an unassigned listing on hold — everything
        // except assigning/reassigning an editor is allowed.
        if (ROLE === "junior") {
          const holdBtn = document.createElement("button");
          holdBtn.type = "button";
          holdBtn.className = "dp-hold-btn";
          holdBtn.textContent = "Hold";
          holdBtn.title = "Put on hold with reason";
          holdBtn.addEventListener("click", e => {
            e.stopPropagation();
            showOnHoldModal("", "edit", reason => setOnHold(reason));
          });
          widget.appendChild(holdBtn);
        }
      }
    }

    function renderAssigned(editor, status) {
      applyRowStatusStyle();
      widget.innerHTML = "";
      widget.appendChild(renderBadge(editor, status));

      const isActive = status === "Assigned" || status === "In Progress";
      const isOnHold = status === "On Hold";
      const isRejected = status === "Rejected";

      // Start button on Assigned or On Hold listings (resume from hold).
      // Both roles get full access — junior can act on any listing, just
      // not assign/reassign the editor.
      if ((ROLE === "senior" || ROLE === "junior") &&
          (status === "Assigned" || status === "On Hold")) {
        const startBtn = document.createElement("button");
        startBtn.type = "button";
        startBtn.className = "dp-start-btn";
        startBtn.textContent = "Start";
        startBtn.addEventListener("click", e => { e.stopPropagation(); markInProgress(); });
        widget.appendChild(startBtn);
      }

      // Restart button on Rejected listings — reopens the listing as a
      // fresh cycle (new row on the sheet, so this rework is tracked and
      // counted separately, same as the automatic recategorize-reopen
      // path) and hands it straight back to the same editor who had it,
      // as Assigned — NOT In Progress; the editor still clicks Start
      // themselves once they actually pick it back up. See
      // restartRejected() below.
      if ((ROLE === "senior" || ROLE === "junior") && isRejected) {
        const restartBtn = document.createElement("button");
        restartBtn.type = "button";
        restartBtn.className = "dp-start-btn";
        restartBtn.textContent = "Restart";
        restartBtn.title = "Reopen this listing as a new cycle and reassign it back to the same editor";
        restartBtn.addEventListener("click", e => { e.stopPropagation(); restartRejected(); });
        widget.appendChild(restartBtn);
      }

      // Hold button for any active listing — both roles.
      if ((ROLE === "senior" || ROLE === "junior") && isActive) {
        const holdBtn = document.createElement("button");
        holdBtn.type = "button";
        holdBtn.className = "dp-hold-btn";
        holdBtn.textContent = "Hold";
        holdBtn.title = "Put on hold with reason";
        holdBtn.addEventListener("click", e => {
          e.stopPropagation();
          showOnHoldModal("", "edit", reason => setOnHold(reason));
        });
        widget.appendChild(holdBtn);
      }

      // View/Edit Reason button when On Hold — editable for both roles.
      if (isOnHold) {
        const reason = (ref && assignmentCache[ref] && assignmentCache[ref].onHoldReason) || "";
        const canEdit = ROLE === "senior" || ROLE === "junior";
        const reasonBtn = document.createElement("button");
        reasonBtn.type = "button";
        reasonBtn.className = "dp-view-reason-btn";
        reasonBtn.textContent = "View Reason";
        reasonBtn.title = "See why this listing is on hold";
        reasonBtn.addEventListener("click", e => {
          e.stopPropagation();
          showOnHoldModal(reason, canEdit ? "edit" : "view",
            canEdit ? r => setOnHold(r) : null);
        });
        widget.appendChild(reasonBtn);
      }
    }

    function openPopover() {
      closeAllPopovers();
      let pop = widget.querySelector(".dp-editor-popover.dp-popover");
      if (!pop) {
        pop = document.createElement("div");
        pop.className = "dp-editor-popover dp-popover";
        widget.appendChild(pop);
      }
      // Rebuilt on every open (not just once) so the today's-count badges
      // and the recommended star reflect whatever's happened since the
      // popover was last opened, rather than freezing at first-render values.
      pop.innerHTML = "";
      const { next, counts } = getAutoAssignRecommendation();
      EDITORS.forEach(name => {
        const opt = document.createElement("button");
        opt.type = "button";
        opt.className = "dp-editor-option" + (name === next ? " is-recommended" : "");
        if (name === next) {
          const star = document.createElement("span");
          star.className = "dp-editor-option-star";
          star.textContent = "\u2605";
          star.title = "Round-robin recommendation \u2014 fewest assigned today";
          opt.appendChild(star);
        }
        const label = document.createElement("span");
        label.className = "dp-editor-option-label";
        label.textContent = name;
        opt.appendChild(label);
        const count = document.createElement("span");
        count.className = "dp-editor-option-count";
        count.textContent = String(counts[name] || 0);
        count.title = "Assigned today";
        opt.appendChild(count);
        opt.addEventListener("click", e => { e.stopPropagation(); assign(name); pop.classList.remove("is-open"); });
        pop.appendChild(opt);
      });
      pop.classList.add("is-open");
    }

    // Senior: full access. Junior: reassign only — an existing assignment
    // has to already be there; junior has no UI path to reach this for a
    // fresh Unassigned listing (see renderUnassigned), and this guard
    // keeps that true even if called directly.
    //
    // opts.isAutoAssign marks this call as machine-triggered (round-robin
    // auto-assign) rather than a deliberate popover click — passed through
    // to the server so it can back off instead of overwriting if the row
    // was genuinely claimed by someone/something else in the meantime (see
    // the isAutoAssign check in the Apps Script's assign action). A manual
    // call always omits it, so a senior's deliberate reassign is never
    // second-guessed by this.
    function assign(editor, opts) {
      const isAutoAssign = !!(opts && opts.isAutoAssign);
      if (!ref) return;
      if (ROLE !== "senior" && ROLE !== "junior") return;
      if (!window.dpRequireName()) return;
      const previousEntryCheck = assignmentCache[ref] || null;
      if (ROLE === "junior" && !previousEntryCheck) return;
      preserveScrollAround(() => {
        const previousEntry = assignmentCache[ref] || null;
        const isReAssign = !!(previousEntry && previousEntry.editor && previousEntry.editor !== editor);
        // "Re-shoot" is a CATEGORY (like Offplan Pending / Photos For QC /
        // Upload Pending), not a workflow status — the assignment status
        // itself always stays "Assigned". If the CRM's own Status badge on
        // this row already says "Completed" (i.e. it's an existing live
        // listing), assigning an editor here means updating photos on
        // something already done, so we tag the category as "Re-shoot"
        // instead of whatever it was before, which is what makes it show
        // up in the Assignment Dashboard's category breakdown. Read fresh
        // off the row DOM at click time — our tracker never stores the
        // CRM's "Completed" status itself, only the tracked categories.
        const parentRow = cell.closest(".table-row.accordion");
        const liveCrmStatus = (parentRow && (extractCrmStatus(parentRow) || parentRow.dataset.dpCrmStatus)) || "";
        const isReshootJob = liveCrmStatus === "Completed";
        const categoryOverride = isReshootJob ? "Re-shoot" : "";
        // Re-assign: clear startedAt and onHoldReason locally so the badge
        // doesn't carry stale info from the previous editor's session.
        //
        // assignedAt/reassignedAt are set locally here (not just left for
        // the next server poll to fill in) specifically so
        // getAutoAssignRecommendation() sees this assignment right away —
        // without it, a run of several listings auto-assigned back-to-back
        // within the same ~12s local-change-protection window (see
        // refreshAssignments) would all look uncounted and round-robin
        // could hand every one of them to the same editor instead of
        // spreading them out.
        const now = new Date().toISOString();
        const carriedAssignedAt = (previousEntry && previousEntry.editor && previousEntry.assignedAt)
          ? previousEntry.assignedAt : now;
        assignmentCache[ref] = { editor, status: "Assigned", title,
          onHoldReason: isReAssign ? "" : (previousEntry && previousEntry.onHoldReason) || "",
          bedrooms: (previousEntry && previousEntry.bedrooms) || "",
          crmStatus: categoryOverride || (previousEntry && previousEntry.crmStatus) || "",
          assignedAt: carriedAssignedAt,
          reassignedAt: isReAssign ? now : "" };
        lastLocalChangeAt[ref] = Date.now();
        cell.dataset.dpAppliedEditor = editor;
        cell.dataset.dpAppliedStatus = "Assigned";
        renderAssigned(editor, "Assigned");
        applyFilters();

        safeSendMessage({ type: "DP_ASSIGN", ref, editor, title, reAssign: isReAssign,
          actionBy: MY_NAME, crmStatus: categoryOverride, isAutoAssign }, resp => {
          // The server declined to write because this ref was already
          // genuinely claimed (by another tab's auto-assign, or a manual
          // assign that landed first) by the time our request got its turn
          // under the Apps Script lock — our optimistic guess above was
          // wrong. Snap straight to whatever the server says is actually
          // true rather than waiting out the usual local-change-protection
          // window, so the row doesn't sit showing the wrong editor for
          // the next several seconds.
          if (resp && resp.ok && resp.data && resp.data.skipped) {
            const actualEditor = resp.data.editor || "";
            const actualStatus = resp.data.status || "";
            assignmentCache[ref] = { ...(assignmentCache[ref] || {}), editor: actualEditor, status: actualStatus };
            lastLocalChangeAt[ref] = Date.now();
            cell.dataset.dpAppliedEditor = actualEditor;
            cell.dataset.dpAppliedStatus = actualStatus;
            if (isActiveStatus(actualStatus)) renderAssigned(actualEditor, actualStatus);
            else renderUnassigned();
            applyFilters();
            return;
          }
          if (!(resp && resp.ok)) {
            console.log("DP assign failed", resp);
            verifyBeforeReverting(ref, "Assigned", () => {
              if (previousEntry) {
                assignmentCache[ref] = previousEntry;
                cell.dataset.dpAppliedEditor = previousEntry.editor || "";
                cell.dataset.dpAppliedStatus = previousEntry.status || "";
                if (isActiveStatus(previousEntry.status)) renderAssigned(previousEntry.editor, previousEntry.status);
                else renderUnassigned();
              } else {
                delete assignmentCache[ref];
                cell.dataset.dpAppliedEditor = "";
                cell.dataset.dpAppliedStatus = "";
                renderUnassigned();
              }
              lastLocalChangeAt[ref] = Date.now();
              applyFilters();
            }, "Could not save the assignment — reverted.\nCheck WEB_APP_URL/TOKEN in background.js.");
          }
        });
      });
    }
    // Exposed so maybeAutoAssign() (module-level, outside this per-cell
    // closure) can trigger a real assign() call — same optimistic-update +
    // write + verify-before-reverting path a manual popover click uses,
    // just invoked programmatically instead of from a click handler.
    cell.__dpAssign = assign;



    // Senior only — assigning, reassigning, and unassigning are all
    // reserved for seniors; juniors get everything else.
    function unassign() {
      if (!ref || ROLE !== "senior") return;
      if (!window.dpRequireName()) return;
      preserveScrollAround(() => {
        const previousEntry = assignmentCache[ref] || null;
        // Row stays in the sheet (see unassign() server-side) so keep it in
        // the local cache too, just marked Unassigned — matches what the
        // next full sync will read back.
        assignmentCache[ref] = { ...(previousEntry || {}), editor: "", status: "Unassigned" };
        lastLocalChangeAt[ref] = Date.now();
        cell.dataset.dpAppliedEditor = "";
        cell.dataset.dpAppliedStatus = "Unassigned";
        renderUnassigned();
        applyFilters();

        safeSendMessage({ type: "DP_UNASSIGN", ref }, resp => {
          if (!(resp && resp.ok)) {
            console.log("DP unassign failed", resp);
            verifyBeforeReverting(ref, "Unassigned", () => {
              if (previousEntry) {
                assignmentCache[ref] = previousEntry;
                cell.dataset.dpAppliedEditor = previousEntry.editor || "";
                cell.dataset.dpAppliedStatus = previousEntry.status || "";
                if (isActiveStatus(previousEntry.status)) renderAssigned(previousEntry.editor, previousEntry.status);
                else renderUnassigned();
                applyFilters();
              }
              lastLocalChangeAt[ref] = Date.now();
            }, "Could not clear the assignment — reverted.\nCheck WEB_APP_URL/TOKEN in background.js.");
          }
        });
      });
    }

    // Both roles can mark In Progress — junior now has full access (not
    // limited to their own assignments), only assign/reassign stays senior-only.
    function markInProgress() {
      if (!ref) return;
      if (!window.dpRequireName()) return;
      preserveScrollAround(() => {
        const previousEntry = assignmentCache[ref] || null;
        // Keep the existing editor name; only the status changes.
        // If senior clicks Start and no editor was set, use the senior's own
        // role label so there's still a name in the badge.
        const editorToKeep = (previousEntry && previousEntry.editor) || MY_NAME || "";
        if (assignmentCache[ref]) {
          assignmentCache[ref] = { ...assignmentCache[ref], status: "In Progress" };
        } else {
          assignmentCache[ref] = { editor: editorToKeep, status: "In Progress", title };
        }
        lastLocalChangeAt[ref] = Date.now();
        cell.dataset.dpAppliedStatus = "In Progress";
        renderAssigned(editorToKeep, "In Progress");
        applyFilters();

        safeSendMessage({ type: "DP_MARK_INPROGRESS", ref, title }, resp => {
          if (!(resp && resp.ok)) {
            console.log("DP markInProgress failed", resp);
            verifyBeforeReverting(ref, "In Progress", () => {
              if (previousEntry) assignmentCache[ref] = previousEntry;
              else delete assignmentCache[ref];
              lastLocalChangeAt[ref] = Date.now();
              cell.dataset.dpAppliedStatus = previousEntry ? previousEntry.status : "";
              if (previousEntry && isActiveStatus(previousEntry.status)) {
                renderAssigned(previousEntry.editor, previousEntry.status);
              } else {
                renderUnassigned();
              }
              applyFilters();
            }, "Could not mark In Progress — reverted.");
          }
        });
      });
    }

    // Both roles can restart a Rejected listing — matches markInProgress's
    // own access rule just above. Unlike markInProgress, this creates a
    // brand-new row server-side (restartRejected — see Apps Script) rather
    // than editing the existing one, so the response doesn't hand back an
    // updated version of what's already in assignmentCache; the whole new
    // entry has to be built locally from scratch, then verified against
    // whatever the server says the LATEST row for this ref now looks like
    // (verifyBeforeReverting already always checks the last-appended row
    // per ref, which is exactly the new row this creates).
    function restartRejected() {
      if (!ref) return;
      if (!window.dpRequireName()) return;
      const previousEntry = assignmentCache[ref] || null;
      const editorToRestartTo = previousEntry && previousEntry.editor;
      if (!editorToRestartTo) {
        console.log("DP restart: no prior editor on file for", ref, "— nothing to restart to");
        return;
      }
      preserveScrollAround(() => {
        const now = new Date().toISOString();
        assignmentCache[ref] = {
          ...previousEntry, editor: editorToRestartTo, status: "Assigned",
          assignedAt: now, assignedBy: `Restarted (${MY_NAME})`,
          startedAt: "", completedAt: "", rejectedAt: "",
          onHoldAt: "", onHoldReason: "", downloadedAt: "",
        };
        delete downloadedCache[ref];
        lastLocalChangeAt[ref] = Date.now();
        cell.dataset.dpAppliedEditor = editorToRestartTo;
        cell.dataset.dpAppliedStatus = "Assigned";
        renderAssigned(editorToRestartTo, "Assigned");
        applyFilters();

        safeSendMessage({ type: "DP_RESTART_REJECTED", ref, title, actionBy: MY_NAME }, resp => {
          if (!(resp && resp.ok && resp.data && resp.data.restarted)) {
            console.log("DP restart failed", resp);
            verifyBeforeReverting(ref, m => m.status === "Assigned" && m.editor === editorToRestartTo, () => {
              if (previousEntry) {
                assignmentCache[ref] = previousEntry;
                cell.dataset.dpAppliedEditor = previousEntry.editor || "";
                cell.dataset.dpAppliedStatus = previousEntry.status || "";
                if (isActiveStatus(previousEntry.status)) renderAssigned(previousEntry.editor, previousEntry.status);
                else renderUnassigned();
              } else {
                delete assignmentCache[ref];
                cell.dataset.dpAppliedEditor = "";
                cell.dataset.dpAppliedStatus = "";
                renderUnassigned();
              }
              lastLocalChangeAt[ref] = Date.now();
              applyFilters();
            }, "Could not restart this listing — reverted.");
          }
        });
      });
    }


    // Senior only — put a listing on hold with a reason.
    function setOnHold(reason) {
      if (!ref) return;
      if (!window.dpRequireName()) return;
      preserveScrollAround(() => {
        const previousEntry = assignmentCache[ref] || null;
        const editor = (previousEntry && previousEntry.editor) || "";
        assignmentCache[ref] = { ...(previousEntry || {}), editor, status: "On Hold", title, onHoldReason: reason };
        lastLocalChangeAt[ref] = Date.now();
        cell.dataset.dpAppliedStatus = "On Hold";
        renderAssigned(editor, "On Hold");
        applyFilters();

        safeSendMessage({ type: "DP_SET_ON_HOLD", ref, reason, title }, resp => {
          if (!(resp && resp.ok)) {
            console.log("DP setOnHold failed", resp);
            verifyBeforeReverting(ref, "On Hold", () => {
              if (previousEntry) assignmentCache[ref] = previousEntry;
              else delete assignmentCache[ref];
              lastLocalChangeAt[ref] = Date.now();
              cell.dataset.dpAppliedStatus = previousEntry ? previousEntry.status : "";
              if (previousEntry && isActiveStatus(previousEntry.status)) renderAssigned(previousEntry.editor, previousEntry.status);
              else renderUnassigned();
              applyFilters();
            }, "Could not set on hold — reverted.");
          }
        });
      });
    }

    // Modal for entering / viewing on-hold reason.
    // mode: "edit" (senior can type and save) | "view" (read-only for junior)
    function showOnHoldModal(existingReason, mode, onSave) {
      document.querySelector(".dp-modal-overlay") && document.querySelector(".dp-modal-overlay").remove();

      const overlay = document.createElement("div");
      overlay.className = "dp-modal-overlay";

      const modal = document.createElement("div");
      modal.className = "dp-modal";
      overlay.appendChild(modal);

      const titleEl = document.createElement("h3");
      titleEl.className = "dp-modal-title";
      titleEl.textContent = mode === "view" ? "On Hold Reason" : existingReason ? "Update Hold Reason" : "Put on Hold";
      modal.appendChild(titleEl);

      const textarea = document.createElement("textarea");
      textarea.className = "dp-modal-textarea";
      textarea.placeholder = "Enter reason for putting this listing on hold...";
      textarea.value = existingReason || "";
      textarea.readOnly = mode === "view";
      if (mode === "view") textarea.style.opacity = "0.65";
      modal.appendChild(textarea);

      const btnRow = document.createElement("div");
      btnRow.className = "dp-modal-btns";

      const cancelBtn = document.createElement("button");
      cancelBtn.type = "button";
      cancelBtn.className = "dp-modal-cancel";
      cancelBtn.textContent = mode === "view" ? "Close" : "Cancel";
      cancelBtn.addEventListener("click", () => overlay.remove());
      btnRow.appendChild(cancelBtn);

      if (mode === "edit" && onSave) {
        const saveBtn = document.createElement("button");
        saveBtn.type = "button";
        saveBtn.className = "dp-modal-save";
        saveBtn.textContent = existingReason ? "Update Reason" : "Put on Hold";
        saveBtn.addEventListener("click", () => {
          const r = textarea.value.trim();
          if (!r) { textarea.style.borderColor = "#e6941a"; return; }
          onSave(r);
          overlay.remove();
        });
        btnRow.appendChild(saveBtn);
      }

      modal.appendChild(btnRow);
      overlay.addEventListener("click", e => { if (e.target === overlay) overlay.remove(); });
      document.body.appendChild(overlay);
      if (mode === "edit") requestAnimationFrame(() => textarea.focus());
    }

    // Unified re-render fn stored on the element — processRows calls this
    function dpRenderStatus() {
      const entry = ref ? assignmentCache[ref] : null;
      const editor = entry && entry.editor ? entry.editor : "";
      const status = entry && entry.status ? entry.status : "";
      cell.dataset.dpAppliedEditor = editor;
      cell.dataset.dpAppliedStatus = status;
      if (isActiveStatus(status)) renderAssigned(editor, status);
      else renderUnassigned();
    }
    cell.__dpRenderStatus = dpRenderStatus;

    // Initial render
    const existing = ref ? assignmentCache[ref] : null;
    cell.dataset.dpAppliedEditor = existing && existing.editor ? existing.editor : "";
    cell.dataset.dpAppliedStatus = existing && existing.status ? existing.status : "";
    cell.dataset.dpDownloaded = !!(ref && downloadedCache[ref]) ? "1" : "0";
    if (existing && isActiveStatus(existing.status)) renderAssigned(existing.editor, existing.status);
    else renderUnassigned();

    return cell;
  }

  // ── processRows ──────────────────────────────────────────────────────────
  const metaSyncCache = {}; // ref -> "bedBucket|crmStatus" already pushed to the sheet this session

  // Persists bedroom count + task category to the sheet for assigned
  // listings only, so the Dashboard can read historical data back from
  // DP_GET_ALL instead of depending on the row still being in the DOM.
  // Category is write-once: once a listing is first seen as Offplan Pending /
  // Photos For QC / Upload Pending, that's locked in for good — later CRM
  // status changes (e.g. to Completed) never overwrite it. Anything that
  // isn't one of those 3 is never sent at all (server also enforces this).
  // Exception: "Re-shoot" is set directly by assign() (see there) when the
  // CRM's own Status shows the listing as already Completed — that's a
  // deliberate override of whatever category was here before, not subject
  // to this write-once rule.
  // Fire-and-forget: failures here shouldn't interrupt the page, and the
  // dashboard falls back to live DOM data whenever the sheet has nothing.
  function syncMetaIfNeeded(ref, bedBucket, crmStatus, title, listingRef) {
    if (!ref) return;
    const entry = assignmentCache[ref];
    // Track metadata for anything the sheet already has a row for — assigned
    // listings, or unassigned listings that were put on hold. A listing with
    // no status at all was never touched, so there's nothing to persist yet.
    if (!entry || !entry.status) return;
    const bedVal = bedBucket === undefined || bedBucket === null ? "" : bedBucket;
    const alreadyCategorized = entry.crmStatus && CATEGORY_OPTIONS.includes(entry.crmStatus);
    const categoryVal = !alreadyCategorized && CATEGORY_OPTIONS.includes(crmStatus) ? crmStatus : "";
    // ListingRef only needs sending if it's not already what's on file —
    // once correct, it shouldn't keep re-sending on every poll pass forever.
    const refVal = (listingRef && listingRef !== entry.listingRef) ? listingRef : "";
    if (!bedVal && !categoryVal && !refVal) return;
    const key = bedVal + "|" + categoryVal + "|" + refVal;
    if (metaSyncCache[ref] === key) return; // nothing changed since last sync
    metaSyncCache[ref] = key;
    chrome.runtime.sendMessage({
      type: "DP_SYNC_META", ref, editor: entry.editor || "", status: entry.status || "",
      bedrooms: bedVal, crmStatus: categoryVal, title: title || entry.title || "",
      listingRef: refVal,
    }, resp => {
      if (chrome.runtime.lastError || !resp || !resp.ok) metaSyncCache[ref] = ""; // allow retry on next pass
    });
  }

  // Auto-reopens a Rejected or Completed listing once the CRM's own
  // category genuinely advances (e.g. a reshoot's photos land in Upload
  // Pending after a rejection, or an agent requests updated photos of a
  // listing that was already Completed). The Apps Script side
  // (reopenOnCategoryChange) has always been able to do this — it's wired
  // all the way through background.js — but nothing ever actually called
  // it from here, so a listing just sat showing "Rejected"/"Completed"
  // forever even after real new work showed up. syncMetaIfNeeded above
  // deliberately won't help with this: once a category is captured it's
  // locked in for good, by design, so the only way to notice "this
  // category actually changed" is to compare the *live* DOM value against
  // what's on file every pass, which is exactly what this does.
  function maybeReopenOnRecategorize(ref, liveCrmStatus, title) {
    if (!ref || !liveCrmStatus) return;
    const entry = assignmentCache[ref];
    if (!entry || (entry.status !== "Rejected" && entry.status !== "Completed")) return;
    if (!CATEGORY_OPTIONS.includes(liveCrmStatus)) return;
    if (liveCrmStatus === entry.crmStatus) return; // nothing's actually changed

    const key = "reopen:" + liveCrmStatus;
    if (metaSyncCache[ref] === key) return; // already attempted this exact transition
    metaSyncCache[ref] = key;

    safeSendMessage(
      { type: "DP_REOPEN_ON_RECATEGORIZE", ref, newCategory: liveCrmStatus, title: title || entry.title || "" },
      resp => {
        if (!(resp && resp.ok && resp.data && resp.data.reopened)) {
          metaSyncCache[ref] = ""; // let the next pass retry (e.g. no name selected yet)
          return;
        }
        // Reflect it locally right away rather than waiting up to 15s for
        // the next poll — same lastLocalChangeAt protection every other
        // optimistic update here uses, so a stale poll can't clobber it.
        // downloadedAt/downloadedCache cleared too, matching the backend
        // reset — whatever was downloaded belongs to the old shoot.
        assignmentCache[ref] = { ...entry, editor: "", status: "Unassigned", crmStatus: liveCrmStatus, downloadedAt: "" };
        delete downloadedCache[ref];
        lastLocalChangeAt[ref] = Date.now();
        processRows();
      }
    );
  }

  function processRows() {
    const rows = getAllRows();
    rows.forEach(row => {
      if (row.dataset.dpOrigIndex === undefined) {
        row.dataset.dpOrigIndex = String(origIndexCounter++);
      }
      const ref = extractRef(row);
      const beds = extractBedrooms(row);
      const bucket = bedroomBucket(beds);
      if (bucket !== null) row.dataset.dpBedrooms = bucket;
      else delete row.dataset.dpBedrooms;

      const crmStatus = extractCrmStatus(row);
      if (crmStatus) row.dataset.dpCrmStatus = crmStatus;
      else delete row.dataset.dpCrmStatus;

      syncMetaIfNeeded(ref, bucket, crmStatus, extractTitle(row), extractReferenceCode(row));
      maybeReopenOnRecategorize(ref, crmStatus, extractTitle(row));

      const inner = row.querySelector(".table-row-inner.is-dropdown");
      if (!inner) return;

      const existingCell = inner.querySelector(".dp-assign-cell");
      if (existingCell && existingCell.dataset.dpRef === (ref || "")) {
        // Sync only when something actually changed
        const existing = ref ? assignmentCache[ref] : null;
        const newEditor = existing && existing.editor ? existing.editor : "";
        const newStatus = existing && existing.status ? existing.status : "";
        if (existingCell.dataset.dpAppliedEditor !== newEditor ||
            existingCell.dataset.dpAppliedStatus !== newStatus) {
          existingCell.dataset.dpAppliedEditor = newEditor;
          existingCell.dataset.dpAppliedStatus = newStatus;
          existingCell.__dpRenderStatus && existingCell.__dpRenderStatus();
        }
        // Called every pass, NOT just inside the change-check above. A
        // listing that's still sitting Unassigned+eligible doesn't produce
        // any editor/status change poll to poll, so gating this on "did
        // something change" meant a listing that missed its one shot (e.g.
        // the very first pass landed before auto-assign was armed, or the
        // toggle got turned on after this row already existed) would just
        // sit there forever without ever being retried. maybeAutoAssign
        // already no-ops cheaply via autoAssignInFlight/eligibility checks
        // for every row that doesn't need it, so calling it unconditionally
        // here is safe.
        maybeAutoAssign(ref, existingCell, crmStatus);
        // Independent of the change-check above — expanding an already-
        // rendered row reveals new .preview-body-wrap cards via a DOM
        // mutation, not a status change, so it wouldn't otherwise trigger
        // a re-tint. Cheap no-op on collapsed rows. Also self-heals any
        // row/card styling React silently wiped via its own re-render.
        existingCell.__dpReassertVisuals && existingCell.__dpReassertVisuals();
        const newDownloaded = ref && downloadedCache[ref] ? "1" : "0";
        if (existingCell.dataset.dpDownloaded !== newDownloaded) {
          existingCell.dataset.dpDownloaded = newDownloaded;
          existingCell.__dpSetDownloadedChecked &&
            existingCell.__dpSetDownloadedChecked(newDownloaded === "1");
        }
        return;
      }

      if (existingCell) existingCell.remove();
      const newCell = renderAssignCell(ref, extractTitle(row), extractReferenceCode(row));
      inner.appendChild(newCell);
      // renderAssignCell's initial render runs before the cell is attached
      // to the page, so applyRowStatusStyle's cell.closest(".table-row.
      // accordion") lookup finds nothing yet and skips the border/tint.
      // Re-run now that the cell is actually in the DOM so first-load rows
      // get styled immediately, not just after a later status change.
      newCell.__dpRenderStatus && newCell.__dpRenderStatus();
      maybeAutoAssign(ref, newCell, crmStatus);
    });

    if (currentSort === "asc" || currentSort === "desc") applySort();
    applyFilters();
    updateAutoAssignIndicator();
  }

  // ── Sort ─────────────────────────────────────────────────────────────────
  function applySort() {
    const rows = getAllRows();
    if (!rows.length) return;
    const parent = rows[0].parentElement;
    if (!parent) return;
    const decorated = rows.map(row => ({
      row,
      bedVal: row.dataset.dpBedrooms === undefined ? null :
        row.dataset.dpBedrooms === "5+" ? 5 : parseInt(row.dataset.dpBedrooms, 10),
      origIdx: parseInt(row.dataset.dpOrigIndex || "0", 10),
    }));
    decorated.sort((a, b) => {
      if (a.bedVal === null && b.bedVal === null) return a.origIdx - b.origIdx;
      if (a.bedVal === null) return 1;
      if (b.bedVal === null) return -1;
      const diff = currentSort === "asc" ? a.bedVal - b.bedVal : b.bedVal - a.bedVal;
      return diff !== 0 ? diff : a.origIdx - b.origIdx;
    });
    // Guard: only touch the DOM if the order actually changed.
    // Calling parent.appendChild() on every row even when already sorted
    // triggers layout reflows on each call, which causes the scroll position
    // to jump every time the MutationObserver fires processRows() after any
    // DOM change (e.g. an assignment badge appearing).
    const alreadySorted = decorated.every(({ row }, idx) => rows[idx] === row);
    if (!alreadySorted) {
      decorated.forEach(({ row }) => parent.appendChild(row));
    }
  }

  // ── Filters ───────────────────────────────────────────────────────────────
  function applyFilters() {
    const rows = getAllRows();
    let shown = 0;
    rows.forEach(row => {
      const bedBucket = row.dataset.dpBedrooms;
      const bedOk = selectedBedroomFilters.size === 0 ||
        (bedBucket && selectedBedroomFilters.has(bedBucket));
      const assignCell = row.querySelector(".dp-assign-cell");
      const editor = assignCell ? assignCell.dataset.dpAppliedEditor || "" : "";
      const editorOk = selectedEditorFilters.size === 0 || selectedEditorFilters.has(editor);
      const crmStatus = row.dataset.dpCrmStatus || "";
      const statusOk = selectedStatusFilters.size === 0 || selectedStatusFilters.has(crmStatus);
      // Never hide a row whose editor-picker popover is open — the user is in
      // the middle of an assignment and hiding the row destroys the popover,
      // forcing them to click Assign repeatedly until filters let it through.
      const hasOpenPopover = !!(row.querySelector(".dp-popover.is-open"));
      const visible = (bedOk && editorOk && statusOk) || hasOpenPopover;
      row.style.display = visible ? "" : "none";
      if (visible) shown++;
    });
    const counter = document.querySelector(".dp-filter-counter");
    if (counter) counter.textContent = `Showing ${shown} of ${rows.length}`;
  }

  // ── Filter bar ────────────────────────────────────────────────────────────
  // Injects the CSS these hover-reveal widgets need (bedroom filter,
  // settings gear) — done via a plain <style> tag rather than the external
  // stylesheet since these are purely presentational additions local to
  // this file. Guarded so it only ever runs once per page.
  function ensureDpHoverStyles() {
    if (document.getElementById("dp-hover-anim-styles")) return;
    const style = document.createElement("style");
    style.id = "dp-hover-anim-styles";
    style.textContent = `
      .dp-hover-reveal { position: relative; display: inline-flex; align-items: center; outline: none; }
      /* Overrides the external stylesheet's sizing for the bar, which was
         set for the old, permanently-visible, much taller content (every
         toggle as its own row). Now that most of that lives behind hover
         triggers, the bar is genuinely shorter — without this override the
         container keeps its old fixed height and leaves a dead gap. */
      .dp-filter-bar { min-height: 0 !important; height: auto !important; }
      .dp-hover-trigger-btn {
        background: none; border: none; color: #9ca3af; cursor: pointer;
        padding: 4px 6px; font-size: 12px; display: flex; align-items: center; gap: 4px;
        transition: color .15s ease;
      }
      .dp-hover-trigger-btn:hover, .dp-hover-reveal.is-open .dp-hover-trigger-btn { color: #e5e7eb; }
      .dp-hover-trigger-caret { display: inline-block; transition: transform .2s ease; font-size: 10px; }
      .dp-hover-reveal.is-open .dp-hover-trigger-caret { transform: rotate(180deg); }

      /* Generic hover-slide panel — used by every trigger in the bar
         (Bedrooms, Sort, Editor, Status, Configuration). Expands
         horizontally in place next to its trigger; collapsed it's clipped
         to zero width. flex-wrap is forced to nowrap even while collapsed
         — without it, a wrapping child list (e.g. the bedroom chips, which
         also carry .dp-chip-wrap's flex-wrap:wrap) would stack into
         multiple rows at max-width:0 and silently reserve that stacked
         height even though nothing is visible. overflow only switches to
         visible once open, so a nested absolute-positioned dropdown
         (Editor/Status/On duty popovers) isn't clipped by this wrapper. */
      .dp-hover-slide-panel {
        display: flex; flex-wrap: nowrap; align-items: center; gap: 6px;
        max-width: 0; opacity: 0; overflow: hidden; white-space: nowrap;
        transition: max-width .28s ease, opacity .2s ease .04s, margin-left .28s ease;
        margin-left: 0;
      }
      .dp-hover-reveal.is-open .dp-hover-slide-panel {
        max-width: 900px; opacity: 1; margin-left: 8px; overflow: visible;
      }
      .dp-settings-row { display: flex; align-items: center; gap: 8px; flex-wrap: nowrap; }
      .dp-settings-row .dp-filter-label { white-space: nowrap; }
    `;
    document.head.appendChild(style);
  }

  // Wires a trigger/panel pair (both already in the DOM, panel a descendant
  // of triggerWrap) so the panel opens on hover and closes shortly after the
  // mouse leaves — the delay is what lets someone move diagonally from the
  // trigger button down into the panel without it snapping shut in transit.
  // Also opens/closes on focus for keyboard access, since hover alone
  // leaves keyboard users with no way in.
  function wireHoverReveal(wrap) {
    let closeTimer = null;
    function open() {
      if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; }
      wrap.classList.add("is-open");
    }
    function scheduleClose() {
      if (closeTimer) clearTimeout(closeTimer);
      closeTimer = setTimeout(() => {
        wrap.classList.remove("is-open");
        // Any popover nested inside (e.g. On duty) shouldn't linger open
        // and invisible for next time this panel is hovered back open.
        wrap.querySelectorAll(".dp-popover.is-open").forEach(p => p.classList.remove("is-open"));
        closeTimer = null;
      }, 220);
    }
    wrap.addEventListener("mouseenter", open);
    wrap.addEventListener("mouseleave", scheduleClose);
    wrap.addEventListener("focusin", open);
    wrap.addEventListener("focusout", e => {
      if (!wrap.contains(e.relatedTarget)) scheduleClose();
    });
  }

  function buildChip(container, value, displayLabel, selectedSet) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "dp-chip";
    chip.textContent = displayLabel;
    chip.dataset.val = value;
    if (selectedSet.has(value)) chip.classList.add("is-active");
    chip.addEventListener("click", () => {
      if (selectedSet.has(value)) { selectedSet.delete(value); chip.classList.remove("is-active"); }
      else { selectedSet.add(value); chip.classList.add("is-active"); }
      applyFilters();
    });
    container.appendChild(chip);
    return chip;
  }

  // Builds one trigger/panel pair for the filter bar: a small borderless
  // button (defaultText + caret) that, on hover, slides a panel open to
  // its right. Callers append whatever controls belong to that filter
  // into the returned .panel, and can call .setLabel() afterwards to
  // reflect the current selection on the trigger itself (as Bedrooms
  // does). Wraps wireHoverReveal so callers don't repeat that wiring for
  // every section.
  function makeHoverTrigger(defaultText) {
    const section = document.createElement("div");
    section.className = "dp-filter-section";
    const wrap = document.createElement("div");
    wrap.className = "dp-hover-reveal";
    wrap.tabIndex = 0;
    const trigger = document.createElement("button");
    trigger.type = "button";
    trigger.className = "dp-hover-trigger-btn";
    function setLabel(text) {
      trigger.innerHTML = `${text} <span class="dp-hover-trigger-caret">\u25BE</span>`;
    }
    setLabel(defaultText);
    const panel = document.createElement("div");
    panel.className = "dp-hover-slide-panel";
    wrap.appendChild(trigger);
    wrap.appendChild(panel);
    wireHoverReveal(wrap);
    section.appendChild(wrap);
    return { section, wrap, trigger, panel, setLabel };
  }

  function ensureFilterBar() {
    if (filterBarInjected && document.querySelector(".dp-filter-bar")) return;
    const rows = getAllRows();
    if (!rows.length) return;
    const anchor = rows[0];
    const parent = anchor.parentElement;
    if (!parent) return;

    const bar = document.createElement("div");
    bar.className = "dp-filter-bar";
    ensureDpHoverStyles();

    // Bedroom chips — borderless trigger, hover reveals the same chip row
    // as before, just hidden until hovered so it doesn't take up space in
    // the bar the rest of the time.
    const bed = makeHoverTrigger("Bedrooms");
    bed.panel.classList.add("dp-chip-wrap"); // chip-specific spacing/wrap rules
    ["0","1","2","3","4","5+"].forEach(v => buildChip(bed.panel, v, bedroomChipLabel(v), selectedBedroomFilters));
    function updateBedTriggerLabel() {
      const activeLabels = Array.from(bed.panel.querySelectorAll(".dp-chip.is-active")).map(c => c.textContent);
      bed.setLabel(activeLabels.length ? `Bedrooms: ${activeLabels.join(", ")}` : "Bedrooms");
    }
    bed.panel.addEventListener("click", updateBedTriggerLabel);
    updateBedTriggerLabel();
    bar.appendChild(bed.section);

    // Sort — trigger reveals the asc/desc buttons, same hover-slide as
    // every other filter now.
    const sortHT = makeHoverTrigger("Sort");
    function refreshSortTriggerLabel() {
      sortHT.setLabel(currentSort === "asc" ? "Sort: 0\u21925+" : currentSort === "desc" ? "Sort: 5+\u21920" : "Sort");
    }
    const sortWrap = document.createElement("div");
    sortWrap.className = "dp-sort-wrap";
    const ascBtn = Object.assign(document.createElement("button"), { type:"button", className:"dp-sort-btn", textContent:"0 \u2192 5+" });
    const descBtn = Object.assign(document.createElement("button"), { type:"button", className:"dp-sort-btn", textContent:"5+ \u2192 0" });
    function refreshSortState() {
      ascBtn.classList.toggle("is-active", currentSort === "asc");
      descBtn.classList.toggle("is-active", currentSort === "desc");
      refreshSortTriggerLabel();
    }
    ascBtn.addEventListener("click", () => { currentSort = currentSort === "asc" ? null : "asc"; refreshSortState(); applySort(); });
    descBtn.addEventListener("click", () => { currentSort = currentSort === "desc" ? null : "desc"; refreshSortState(); applySort(); });
    sortWrap.appendChild(ascBtn); sortWrap.appendChild(descBtn);
    sortHT.panel.appendChild(sortWrap);
    bar.appendChild(sortHT.section);

    // Editor dropdown — trigger reveals the "All editors ▾" button, whose
    // own click still opens the checkbox popover as before.
    const editorHT = makeHoverTrigger("Editor");
    const editorWrap = document.createElement("div");
    editorWrap.className = "dp-editor-filter-wrap";
    const editorBtn = Object.assign(document.createElement("button"), { type:"button", className:"dp-editor-filter-btn" });
    const editorPop = document.createElement("div");
    editorPop.className = "dp-editor-filter-popover dp-popover";
    function updateEditorBtnLabel() {
      const summary = selectedEditorFilters.size === 0 ? "" :
        Array.from(selectedEditorFilters).map(v => v === UNASSIGNED_KEY ? "Unassigned" : v).join(", ");
      editorBtn.textContent = (summary || "All editors") + " \u25BE";
      editorHT.setLabel(summary ? `Editor: ${summary}` : "Editor");
    }
    function buildEditorOpt(value, labelText) {
      const optLabel = document.createElement("label");
      optLabel.className = "dp-editor-filter-option";
      const cb = document.createElement("input");
      cb.type = "checkbox"; cb.checked = selectedEditorFilters.has(value);
      cb.addEventListener("change", () => {
        if (cb.checked) selectedEditorFilters.add(value); else selectedEditorFilters.delete(value);
        updateEditorBtnLabel(); applyFilters();
      });
      const sp = document.createElement("span"); sp.textContent = labelText;
      optLabel.appendChild(cb); optLabel.appendChild(sp);
      editorPop.appendChild(optLabel);
    }
    EDITORS.forEach(n => buildEditorOpt(n, n));
    buildEditorOpt(UNASSIGNED_KEY, "Unassigned");
    updateEditorBtnLabel();
    editorBtn.addEventListener("click", e => {
      e.stopPropagation();
      const wasOpen = editorPop.classList.contains("is-open");
      closeAllPopovers();
      if (!wasOpen) editorPop.classList.add("is-open");
    });
    editorPop.addEventListener("click", e => e.stopPropagation());
    editorWrap.appendChild(editorBtn); editorWrap.appendChild(editorPop);
    editorHT.panel.appendChild(editorWrap);
    bar.appendChild(editorHT.section);

    // Status dropdown — same hover-then-click pattern as Editor.
    const statusHT = makeHoverTrigger("Status");
    const statusWrap = document.createElement("div");
    statusWrap.className = "dp-editor-filter-wrap";
    const statusBtn = Object.assign(document.createElement("button"), { type:"button", className:"dp-editor-filter-btn" });
    const statusPop = document.createElement("div");
    statusPop.className = "dp-editor-filter-popover dp-popover";
    function updateStatusBtnLabel() {
      const summary = selectedStatusFilters.size === 0 ? "" : Array.from(selectedStatusFilters).join(", ");
      statusBtn.textContent = (summary || "All statuses") + " \u25BE";
      statusHT.setLabel(summary ? `Status: ${summary}` : "Status");
    }
    function buildStatusOpt(value) {
      const optLabel = document.createElement("label");
      optLabel.className = "dp-editor-filter-option";
      const cb = document.createElement("input");
      cb.type = "checkbox"; cb.checked = selectedStatusFilters.has(value);
      cb.addEventListener("change", () => {
        if (cb.checked) selectedStatusFilters.add(value); else selectedStatusFilters.delete(value);
        updateStatusBtnLabel(); applyFilters();
      });
      const sp = document.createElement("span"); sp.textContent = value;
      optLabel.appendChild(cb); optLabel.appendChild(sp);
      statusPop.appendChild(optLabel);
    }
    STATUS_OPTIONS.forEach(buildStatusOpt);
    updateStatusBtnLabel();
    statusBtn.addEventListener("click", e => {
      e.stopPropagation();
      const wasOpen = statusPop.classList.contains("is-open");
      closeAllPopovers();
      if (!wasOpen) statusPop.classList.add("is-open");
    });
    statusPop.addEventListener("click", e => e.stopPropagation());
    statusWrap.appendChild(statusBtn); statusWrap.appendChild(statusPop);
    statusHT.panel.appendChild(statusWrap);
    bar.appendChild(statusHT.section);

    // Configuration (Open in new tab / Auto-assign / On duty) used to live
    // here as its own hover-revealed panel. It's now controlled entirely
    // from the side panel's Settings drawer instead — this file still runs
    // the actual engine behind each of those (openListingInNewTabEnabled's
    // click-handling below, and the whole "── Round-robin auto-assign ──"
    // section up top), it just no longer renders or owns the toggles
    // themselves. See the chrome.storage.onChanged listener further down
    // for how a change made in the side panel reaches this tab live.

    // Clear + counter + dashboard
    const toolsSection = document.createElement("div");
    toolsSection.className = "dp-filter-section dp-filter-tools";
    const clearBtn = Object.assign(document.createElement("button"), {
      type:"button", className:"dp-filter-clear", textContent:"Clear filters"
    });
    clearBtn.addEventListener("click", () => {
      selectedBedroomFilters.clear(); selectedEditorFilters.clear(); selectedStatusFilters.clear(); currentSort = null;
      bar.querySelectorAll(".dp-chip.is-active").forEach(c => c.classList.remove("is-active"));
      updateBedTriggerLabel();
      editorPop.querySelectorAll('input[type="checkbox"]').forEach(cb => cb.checked = false);
      statusPop.querySelectorAll('input[type="checkbox"]').forEach(cb => cb.checked = false);
      updateEditorBtnLabel(); updateStatusBtnLabel(); refreshSortState(); applySort(); applyFilters();
    });
    const counter = Object.assign(document.createElement("span"), { className:"dp-filter-counter" });
    toolsSection.appendChild(clearBtn); toolsSection.appendChild(counter);

    const dashBtn = Object.assign(document.createElement("button"), {
      type: "button", className: "dp-dash-open-btn", textContent: "\uD83D\uDCCA Dashboard"
    });
    dashBtn.addEventListener("click", e => { e.stopPropagation(); showDashboardModal(); });
    toolsSection.appendChild(dashBtn);

    bar.appendChild(toolsSection);

    parent.insertBefore(bar, anchor);
    filterBarInjected = true;
    applyFilters();
    updateAutoAssignIndicator();
  }

  // ── Refresh from sheet ───────────────────────────────────────────────────
  function refreshAssignments() {
    if (refreshInFlight) return;
    refreshInFlight = true;

    safeSendMessage({ type: "DP_GET_ALL" }, resp => {
      refreshInFlight = false;
      if (resp && resp.ok && resp.data && Array.isArray(resp.data.assignments)) {
        const freshAssign = {}, freshDownloaded = {};
        resp.data.assignments.forEach(a => {
          if (!a.ref) return;
          freshAssign[a.ref] = {
            editor: a.editor, status: a.status, title: a.title,
            assignedAt:     a.assignedAt     || "",
            startedAt:      a.startedAt      || "",
            completedAt:    a.completedAt    || "",
            rejectedAt:     a.rejectedAt     || "",
            onHoldAt:       a.onHoldAt       || "",
            onHoldReason:   a.onHoldReason   || "",
            bedrooms:       a.bedrooms       || "",
            crmStatus:      a.crmStatus      || "",
            downloadedAt:   a.downloadedAt   || "",
            assignedBy:     a.assignedBy     || "",
            reassignedFrom: a.reassignedFrom || "",
            reassignedTo:   a.reassignedTo   || "",
            reassignedBy:   a.reassignedBy   || "",
            reassignedAt:   a.reassignedAt   || "",
            unassignedAt:   a.unassignedAt   || "",
            history:        Array.isArray(a.history) ? a.history : [],
            listingRef:     a.listingRef     || "",
          };
          if (a.downloaded) freshDownloaded[a.ref] = true;
        });
        const mergedAssign = {}, mergedDownloaded = {};
        const allRefs = new Set([...Object.keys(assignmentCache), ...Object.keys(downloadedCache),
          ...Object.keys(freshAssign), ...Object.keys(freshDownloaded)]);
        // Local changes are protected for a fixed cooldown after the
        // click, not just "did this poll start before/after it" — a
        // write (assign/complete/hold/etc.) goes through Apps Script's
        // write lock and isn't instant, especially under concurrent
        // writes from other editors. A poll that technically starts
        // *after* your click can still have its read reach the sheet
        // *before* your write actually lands, reading genuinely-accurate-
        // in-that-instant "old" data and clobbering the correct local
        // state — which then self-corrects on the next poll once the
        // write has landed. That's exactly the "reverts, then fixes
        // itself a bit later" symptom. 12s comfortably covers a normal
        // write plus reasonable lock-wait time under load.
        const LOCAL_CHANGE_COOLDOWN_MS = 12000;
        allRefs.forEach(ref => {
          const localAt = lastLocalChangeAt[ref] || 0;
          if (Date.now() - localAt < LOCAL_CHANGE_COOLDOWN_MS) {
            if (assignmentCache[ref]) mergedAssign[ref] = assignmentCache[ref];
            if (downloadedCache[ref]) mergedDownloaded[ref] = true;
          } else {
            if (freshAssign[ref]) mergedAssign[ref] = freshAssign[ref];
            if (freshDownloaded[ref]) mergedDownloaded[ref] = true;
          }
        });
        assignmentCache = mergedAssign;
        downloadedCache = mergedDownloaded;
        // Refreshed alongside every regular fetch, not on its own separate
        // poll — see the server-side comment on why it's bundled into the
        // same response. Re-syncs the popover's checkboxes too, in case
        // another tab/device toggled someone since our last fetch.
        if (resp.data.autoAssignConfig && typeof resp.data.autoAssignConfig === "object") {
          autoAssignConfig = resp.data.autoAssignConfig;
          syncAutoAssignEligibilityUI();
        }
        processRows();
        // Arm auto-assign only AFTER this pass has rendered — so if the
        // toggle was already on from a previous session, this first pass
        // (which can contain a whole backlog of long-Unassigned listings)
        // is exempt, and only listings that appear from here on are
        // treated as "new" and eligible for auto-assignment.
        if (!autoAssignArmDone) { autoAssignArmDone = true; autoAssignArmed = true; }

        // Persist for next page load — see the init block's hydration
        // step below for why. chrome.storage.local's quota/write-rate is
        // generous enough that doing this every refresh (~15s) is fine.
        try {
          chrome.storage.local.set({
            dpAssignSnapshot: JSON.stringify({ assignmentCache, downloadedCache, savedAt: Date.now() })
          });
        } catch (e) { /* non-fatal — worst case, next load just starts empty as before */ }
      } else if (resp && !resp.ok) {
        // console.log, not console.warn/error — this is expected/
        // self-healing (auto-retries on the very next 15s poll), not a
        // real fault. warn/error here gets picked up by Chrome's own
        // chrome://extensions Errors dashboard, which was showing this to
        // non-technical viewers as if it were an actual bug.
        console.log("DP Photo Request Assigner: refresh failed (will retry automatically) —", resp.error);
      }
    });
  }

  // ── Dashboard (senior only) ──────────────────────────────────────────────
  function fmtRelative(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    if (isNaN(d)) return "";
    const mins = Math.round((Date.now() - d.getTime()) / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.round(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return `${Math.round(hrs / 24)}d ago`;
  }

  function startOfLocalDay(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
  // Monday of the calendar week containing d. getDay() is 0=Sun..6=Sat;
  // (day+6)%7 gives the number of days since the most recent Monday for
  // every day of the week, including Sunday (0 -> 6 days since Monday).
  function startOfWeekMonday(d) {
    const day = d.getDay();
    return addDays(startOfLocalDay(d), -((day + 6) % 7));
  }
  function addDays(d, n) { return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n); }
  function startOfMonth(d) { return new Date(d.getFullYear(), d.getMonth(), 1); }

  // Turns a scope descriptor into a [start, end) local-time range, or null
  // for "all" (no filtering).
  //   "today" | "yesterday" | "week"  — "week" = rolling last 7 days,
  //   ending yesterday (today is excluded — it's covered by "today")
  //   { type: "custom", start: "YYYY-MM-DD", end: "YYYY-MM-DD" } — inclusive
  //   "all" — no range, everything matches
  function scopeToRange(scope) {
    const now = new Date();
    if (scope === "today") {
      const start = startOfLocalDay(now);
      return [start, addDays(start, 1)];
    }
    if (scope === "yesterday") {
      const start = addDays(startOfLocalDay(now), -1);
      return [start, addDays(start, 1)];
    }
    if (scope === "week") {
      // Rolling 7-day window ending yesterday (today is excluded, since
      // it's still in progress and already covered by "Today").
      const yesterday = addDays(startOfLocalDay(now), -1);
      const start = addDays(yesterday, -6);
      return [start, addDays(yesterday, 1)];
    }
    if (scope === "thisWeek") {
      // Calendar week, Monday through Sunday — e.g. if today is anywhere
      // from Mon Jul 20 to Sun Jul 26, this resolves to that same Jul 20 –
      // Jul 26 range. Clicking it again next week resolves to Jul 27 – Aug 2.
      const monday = startOfWeekMonday(now);
      return [monday, addDays(monday, 7)];
    }
    if (scope === "month") {
      // 1st of the current month through the end of TODAY, not the whole
      // month — e.g. on Aug 13 this is Aug 1–13, and on Aug 14 (no code
      // change needed) it's automatically Aug 1–14, since both ends are
      // computed fresh from "now" every time this runs rather than being
      // a fixed range someone has to update.
      const start = startOfMonth(now);
      return [start, addDays(startOfLocalDay(now), 1)];
    }
    if (scope && scope.type === "custom") {
      if (!scope.start || !scope.end) return null;
      const start = new Date(scope.start + "T00:00:00");
      const end = new Date(scope.end + "T00:00:00");
      if (isNaN(start) || isNaN(end)) return null;
      return [start, addDays(end, 1)]; // end date is inclusive
    }
    return null; // "all"
  }

  function isWithinRange(iso, range) {
    if (!range) return true;
    if (!iso) return false;
    const d = new Date(iso);
    if (isNaN(d)) return false;
    return d >= range[0] && d < range[1];
  }

  // Combines: our own assignment tracking (editor, assignedAt, and now
  // bedrooms/category too — all from the sheet via assignmentCache) with a
  // DOM fallback for rows the sheet hasn't been synced with yet (e.g. right
  // after upgrading, or a listing assigned in a session before this synced).
  // scope: "today" | "yesterday" | "all"
  //
  // Only the fixed task categories (Offplan Pending / Photos For QC /
  // Stock Photos For QC / Upload Pending / Re-shoot) are tracked. A listing
  // whose category was never captured while it was still in one of those
  // states (e.g. it's already moved on to Completed and we have no record)
  // can't be recovered and is excluded from the per-editor tables — counted
  // separately as uncategorized.
  // Only Upload Pending needs a bedroom breakdown — the other categories
  // are tracked as simple counts.
  const BED_TRACKED_CATEGORIES = ["Upload Pending"];

  // Defends against a category value that looks identical on screen but
  // isn't byte-for-byte equal to a CATEGORY_OPTIONS entry — most commonly a
  // non-breaking space picked up from the CRM page's own DOM text, or extra
  // whitespace from manual entry. Collapses any run of whitespace (which in
  // JS \s already covers \u00A0) to a single space and trims the ends.
  function normCategory(v) { return (v || "").replace(/\s+/g, " ").trim(); }

  function emptyCategoryTally() {
    const t = {};
    CATEGORY_OPTIONS.forEach(c => t[c] = {
      completed: 0, pending: 0, onHold: 0, rejected: 0, total: 0, beds: {},
      // Individual DP-REQ refs behind each count, so a cell's number can
      // be clicked to reveal exactly which listings it's made of.
      refs: { completed: [], pending: [], onHold: [], rejected: [] },
    });
    return t;
  }

  function computeDashboardStats(scope) {
    const range = scopeToRange(scope);
    const byEditor = {};
    const team = { categories: emptyCategoryTally(), total: 0 };
    const unassigned = { categories: emptyCategoryTally(), total: 0, latest: null };
    let fromDomFallback = 0, uncategorized = 0;

    // Build a DOM lookup (ref -> {bedBucket, crmStatus}) for rows currently
    // rendered on the page, used only as a fallback.
    const domByRef = {};
    getAllRows().forEach(row => {
      const cell = row.querySelector(".dp-assign-cell");
      const ref = cell && cell.dataset.dpRef;
      if (!ref) return;
      domByRef[ref] = {
        bedBucket: row.dataset.dpBedrooms !== undefined ? row.dataset.dpBedrooms : "",
        crmStatus: row.dataset.dpCrmStatus || "",
      };
    });

    Object.keys(assignmentCache).forEach(ref => {
      const entry = assignmentCache[ref];
      // Track anything with a status — assigned listings, or unassigned
      // listings that were put on hold. Untouched listings have no status.
      if (!entry || !entry.status) return;

      // Unassigned listings have no assignedAt (they were never assigned) —
      // use onHoldAt instead so date-range scoping still works for them.
      const scopeTimestamp = entry.assignedAt || entry.onHoldAt || "";
      if (!isWithinRange(scopeTimestamp, range)) return;

      let bedBucket = entry.bedrooms || "";
      // Category is locked in from the sheet once set. Only fall back to a
      // live DOM read if the sheet has nothing yet — and only accept that
      // fallback if it's actually one of the tracked categories.
      const crmStatusNorm = normCategory(entry.crmStatus);
      let category = crmStatusNorm && CATEGORY_OPTIONS.includes(crmStatusNorm) ? crmStatusNorm : "";

      const domInfo = domByRef[ref];
      if (!bedBucket && domInfo) bedBucket = domInfo.bedBucket;
      if (!category && domInfo) {
        const domCrmNorm = normCategory(domInfo.crmStatus);
        if (CATEGORY_OPTIONS.includes(domCrmNorm)) {
          category = domCrmNorm;
          fromDomFallback++;
        }
      }

      if (!category) { uncategorized++; return; } // not one of the tracked categories — excluded
      if (!bedBucket) bedBucket = "?";

      const editor = entry.editor || "";
      const status = entry.status || "";
      const bucket = status === "Completed" ? "completed" : status === "Rejected" ? "rejected" :
        status === "On Hold" ? "onHold" : "pending";

      const target = editor
        ? (byEditor[editor] || (byEditor[editor] = { total: 0, latest: null, categories: emptyCategoryTally() }))
        : unassigned;

      target.total++;
      target.categories[category][bucket]++;
      target.categories[category].total++;
      target.categories[category].refs[bucket].push(ref);

      if (editor) {
        team.categories[category][bucket]++;
        team.categories[category].total++;
        team.categories[category].refs[bucket].push(ref);
        team.total++;
      }

      if (BED_TRACKED_CATEGORIES.includes(category)) {
        target.categories[category].beds[bedBucket] = (target.categories[category].beds[bedBucket] || 0) + 1;
        if (editor) team.categories[category].beds[bedBucket] = (team.categories[category].beds[bedBucket] || 0) + 1;
      }

      if (scopeTimestamp && (!target.latest || new Date(scopeTimestamp) > new Date(target.latest.assignedAt))) {
        target.latest = { ref, title: entry.title || "", bedBucket, crmStatus: category, assignedAt: scopeTimestamp };
      }
    });

    return { byEditor, team, unassigned, fromDomFallback, uncategorized };
  }

  // Clicking any non-zero count in the dashboard opens this, listing the
  // individual DP-REQ refs that make up that number. Stacks on top of the
  // dashboard modal (same overlay/modal classes, appended later so it
  // paints on top) and closes independently via its own overlay click / X.
  function showRefsModal(title, refs) {
    const existingOverlay = document.querySelector(".dp-refs-modal-overlay");
    if (existingOverlay) existingOverlay.remove();

    const uniqueRefs = Array.from(new Set(refs)).sort();

    const overlay = document.createElement("div");
    overlay.className = "dp-modal-overlay dp-refs-modal-overlay";
    overlay.addEventListener("click", e => { if (e.target === overlay) overlay.remove(); });

    const modal = document.createElement("div");
    modal.className = "dp-modal dp-refs-modal";
    overlay.appendChild(modal);

    const titleEl = document.createElement("h3");
    titleEl.className = "dp-modal-title";
    titleEl.textContent = `${title} (${uniqueRefs.length})`;
    modal.appendChild(titleEl);

    const list = document.createElement("div");
    list.className = "dp-refs-list";
    if (uniqueRefs.length === 0) {
      const empty = document.createElement("div");
      empty.className = "dp-history-empty";
      empty.textContent = "No reference numbers found.";
      list.appendChild(empty);
    } else {
      uniqueRefs.forEach(ref => {
        const item = document.createElement("button");
        item.type = "button";
        item.className = "dp-refs-list-item dp-refs-list-item-clickable";
        item.title = "Copy and search this reference in the CRM";

        const refText = document.createElement("span");
        refText.className = "dp-refs-list-ref";
        refText.textContent = ref;
        item.appendChild(refText);

        const actionHint = document.createElement("span");
        actionHint.className = "dp-refs-list-action";
        actionHint.textContent = "Search in CRM \u2197";
        item.appendChild(actionHint);

        item.addEventListener("click", () => {
          if (item.classList.contains("is-busy")) return;
          item.classList.add("is-busy");
          actionHint.textContent = "Opening\u2026";

          navigator.clipboard.writeText(ref).then(() => {
            showCopyToast(`Copied to clipboard: ${ref}`);
          }).catch(() => {});
          safeSendMessage({ type: "DP_AUTO_SEARCH", ref }, resp => {
            if (resp && resp.ok) {
              actionHint.textContent = "Done \u2713";
            } else {
              actionHint.textContent = "Copied \u2014 open CRM manually";
            }
            setTimeout(() => {
              actionHint.textContent = "Search in CRM \u2197";
              item.classList.remove("is-busy");
            }, 1600);
          });
        });

        list.appendChild(item);
      });
    }
    modal.appendChild(list);

    const btnRow = document.createElement("div");
    btnRow.className = "dp-modal-btns";

    const copyBtn = document.createElement("button");
    copyBtn.type = "button";
    copyBtn.className = "dp-modal-cancel";
    copyBtn.textContent = "Copy List";
    copyBtn.disabled = uniqueRefs.length === 0;
    copyBtn.addEventListener("click", () => {
      navigator.clipboard.writeText(uniqueRefs.join("\n")).then(() => {
        copyBtn.textContent = "Copied!";
        showCopyToast(`Copied ${uniqueRefs.length} reference${uniqueRefs.length === 1 ? "" : "s"} to clipboard`);
        setTimeout(() => { copyBtn.textContent = "Copy List"; }, 1500);
      }).catch(() => {});
    });
    btnRow.appendChild(copyBtn);

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "dp-modal-save";
    closeBtn.textContent = "Close";
    closeBtn.addEventListener("click", () => overlay.remove());
    btnRow.appendChild(closeBtn);

    modal.appendChild(btnRow);
    document.body.appendChild(overlay);
  }

  // Builds one Completed/Pending/On Hold/Rejected/Total cell. Zero-count
  // cells stay as plain "–" text; non-zero cells become a clickable button
  // that opens showRefsModal with the refs behind that specific number.
  function buildStatCell(count, refs, modalTitle, extraClass) {
    const td = document.createElement("td");
    if (extraClass) td.className = extraClass;
    if (count > 0 && refs && refs.length > 0) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "dp-dash-stat-btn";
      btn.textContent = count;
      btn.title = "Click to see reference numbers";
      btn.addEventListener("click", () => showRefsModal(modalTitle, refs));
      td.appendChild(btn);
    } else {
      td.textContent = count || "\u2013";
    }
    return td;
  }

  // Category | Completed | Pending | On Hold | Rejected | Total table — used
  // both per-editor and for the whole-team overview. ownerLabel (e.g. a
  // name, "Whole Team", or "Unassigned (On Hold)") prefixes the modal title
  // shown when a cell is clicked, so it's clear whose numbers you're
  // looking at.
  function buildCategoryStatusTable(categories, ownerLabel) {
    const table = document.createElement("table");
    table.className = "dp-dash-table";

    const thead = document.createElement("thead");
    const headRow = document.createElement("tr");
    ["Category", "Completed", "Pending", "On Hold", "Rejected", "Total"].forEach(label => {
      const th = document.createElement("th");
      th.textContent = label;
      headRow.appendChild(th);
    });
    thead.appendChild(headRow);
    table.appendChild(thead);

    const emptyRefs = { completed: [], pending: [], onHold: [], rejected: [] };
    const tbody = document.createElement("tbody");
    const sums = { completed: 0, pending: 0, onHold: 0, rejected: 0, total: 0 };
    const sumRefs = { completed: [], pending: [], onHold: [], rejected: [] };
    CATEGORY_OPTIONS.forEach(cat => {
      const d = categories[cat] || { completed: 0, pending: 0, onHold: 0, rejected: 0, total: 0 };
      const refs = d.refs || emptyRefs;
      sums.completed += d.completed; sums.pending += d.pending; sums.onHold += d.onHold;
      sums.rejected += d.rejected; sums.total += d.total;
      sumRefs.completed = sumRefs.completed.concat(refs.completed);
      sumRefs.pending = sumRefs.pending.concat(refs.pending);
      sumRefs.onHold = sumRefs.onHold.concat(refs.onHold);
      sumRefs.rejected = sumRefs.rejected.concat(refs.rejected);

      const row = document.createElement("tr");
      const labelTd = document.createElement("td");
      labelTd.className = "dp-dash-status-label";
      labelTd.textContent = cat;
      row.appendChild(labelTd);

      row.appendChild(buildStatCell(d.completed, refs.completed, `${ownerLabel} \u00B7 ${cat} \u00B7 Completed`));
      row.appendChild(buildStatCell(d.pending, refs.pending, `${ownerLabel} \u00B7 ${cat} \u00B7 Pending`));
      row.appendChild(buildStatCell(d.onHold, refs.onHold, `${ownerLabel} \u00B7 ${cat} \u00B7 On Hold`));
      row.appendChild(buildStatCell(d.rejected, refs.rejected, `${ownerLabel} \u00B7 ${cat} \u00B7 Rejected`));

      const rowAllRefs = refs.completed.concat(refs.pending, refs.onHold, refs.rejected);
      row.appendChild(buildStatCell(d.total, rowAllRefs, `${ownerLabel} \u00B7 ${cat} \u00B7 All statuses`, "dp-dash-row-total"));
      tbody.appendChild(row);
    });
    table.appendChild(tbody);

    const tfoot = document.createElement("tfoot");
    const footRow = document.createElement("tr");
    const footLabel = document.createElement("td");
    footLabel.textContent = "Total";
    footRow.appendChild(footLabel);
    footRow.appendChild(buildStatCell(sums.completed, sumRefs.completed, `${ownerLabel} \u00B7 Completed`));
    footRow.appendChild(buildStatCell(sums.pending, sumRefs.pending, `${ownerLabel} \u00B7 Pending`));
    footRow.appendChild(buildStatCell(sums.onHold, sumRefs.onHold, `${ownerLabel} \u00B7 On Hold`));
    footRow.appendChild(buildStatCell(sums.rejected, sumRefs.rejected, `${ownerLabel} \u00B7 Rejected`));
    const grandRefs = sumRefs.completed.concat(sumRefs.pending, sumRefs.onHold, sumRefs.rejected);
    footRow.appendChild(buildStatCell(sums.total, grandRefs, `${ownerLabel} \u00B7 All statuses`));
    tfoot.appendChild(footRow);
    table.appendChild(tfoot);

    return table;
  }

  // Bedroom breakdown for a single category (Upload Pending only) — one row
  // of raw counts, no completed/pending split (bedroom count doesn't change
  // based on progress, so splitting it further wouldn't add anything).
  function buildBedTable(beds, rowLabel) {
    const table = document.createElement("table");
    table.className = "dp-dash-table dp-dash-bed-table";

    const thead = document.createElement("thead");
    const headRow = document.createElement("tr");
    headRow.appendChild(document.createElement("th"));
    BED_BUCKETS.forEach(b => {
      const th = document.createElement("th");
      th.textContent = bedroomChipLabel(b);
      headRow.appendChild(th);
    });
    const totalTh = document.createElement("th");
    totalTh.textContent = "Total";
    headRow.appendChild(totalTh);
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = document.createElement("tbody");
    const row = document.createElement("tr");
    const labelTd = document.createElement("td");
    labelTd.className = "dp-dash-status-label";
    labelTd.textContent = rowLabel;
    row.appendChild(labelTd);
    let total = 0;
    BED_BUCKETS.forEach(b => {
      const count = beds[b] || 0;
      total += count;
      const td = document.createElement("td");
      td.textContent = count || "\u2013";
      row.appendChild(td);
    });
    const totalTd = document.createElement("td");
    totalTd.className = "dp-dash-row-total";
    totalTd.textContent = total || "\u2013";
    row.appendChild(totalTd);
    tbody.appendChild(row);
    table.appendChild(tbody);

    return table;
  }

  function appendBedTableIfAny(card, categories) {
    BED_TRACKED_CATEGORIES.forEach(cat => {
      const beds = categories[cat] && categories[cat].beds;
      if (!beds || Object.keys(beds).length === 0) return;
      const heading = document.createElement("div");
      heading.className = "dp-dash-subheading";
      heading.textContent = `${cat} \u2014 by bedrooms`;
      card.appendChild(heading);
      card.appendChild(buildBedTable(beds, cat));
    });
  }

  // Collapses an editor's per-category tallies (Offplan Pending, Photos
  // For QC, etc.) down into one Completed/Pending/On Hold/Rejected/Total
  // row (plus the refs behind each number) for the Quick Report table.
  function sumEditorCategories(data) {
    const sums = { completed: 0, pending: 0, onHold: 0, rejected: 0, total: 0 };
    const refs = { completed: [], pending: [], onHold: [], rejected: [] };
    CATEGORY_OPTIONS.forEach(cat => {
      const d = data.categories[cat];
      if (!d) return;
      sums.completed += d.completed;
      sums.pending += d.pending;
      sums.onHold += d.onHold;
      sums.rejected += d.rejected;
      sums.total += d.total;
      if (d.refs) {
        refs.completed = refs.completed.concat(d.refs.completed);
        refs.pending = refs.pending.concat(d.refs.pending);
        refs.onHold = refs.onHold.concat(d.refs.onHold);
        refs.rejected = refs.rejected.concat(d.refs.rejected);
      }
    });
    return { sums, refs };
  }

  // One row per editor, same column shape as the per-category tables
  // (Completed / Pending / On Hold / Rejected / Total), with a Total
  // footer row summing the whole team — matches the quick spreadsheet
  // report layout (see Image 2 in the request). Every non-zero count is
  // clickable, same as the per-category tables below.
  function buildQuickReportTable(byEditor, editorNames) {
    const table = document.createElement("table");
    table.className = "dp-dash-table dp-dash-quick-report-table";

    const thead = document.createElement("thead");
    const headRow = document.createElement("tr");
    headRow.appendChild(document.createElement("th"));
    ["Completed", "Pending", "On Hold", "Rejected", "Total"].forEach(label => {
      const th = document.createElement("th");
      th.textContent = label;
      headRow.appendChild(th);
    });
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = document.createElement("tbody");
    const grand = { completed: 0, pending: 0, onHold: 0, rejected: 0, total: 0 };
    const grandRefs = { completed: [], pending: [], onHold: [], rejected: [] };
    editorNames.forEach(name => {
      const { sums, refs } = sumEditorCategories(byEditor[name]);
      grand.completed += sums.completed;
      grand.pending += sums.pending;
      grand.onHold += sums.onHold;
      grand.rejected += sums.rejected;
      grand.total += sums.total;
      grandRefs.completed = grandRefs.completed.concat(refs.completed);
      grandRefs.pending = grandRefs.pending.concat(refs.pending);
      grandRefs.onHold = grandRefs.onHold.concat(refs.onHold);
      grandRefs.rejected = grandRefs.rejected.concat(refs.rejected);

      const row = document.createElement("tr");
      const nameTd = document.createElement("td");
      nameTd.className = "dp-dash-status-label";
      nameTd.textContent = name;
      row.appendChild(nameTd);

      row.appendChild(buildStatCell(sums.completed, refs.completed, `${name} \u00B7 Completed`));
      row.appendChild(buildStatCell(sums.pending, refs.pending, `${name} \u00B7 Pending`));
      row.appendChild(buildStatCell(sums.onHold, refs.onHold, `${name} \u00B7 On Hold`));
      row.appendChild(buildStatCell(sums.rejected, refs.rejected, `${name} \u00B7 Rejected`));
      const rowAllRefs = refs.completed.concat(refs.pending, refs.onHold, refs.rejected);
      row.appendChild(buildStatCell(sums.total, rowAllRefs, `${name} \u00B7 All statuses`, "dp-dash-row-total"));
      tbody.appendChild(row);
    });
    table.appendChild(tbody);

    const tfoot = document.createElement("tfoot");
    const footRow = document.createElement("tr");
    const footLabel = document.createElement("td");
    footLabel.textContent = "Total";
    footRow.appendChild(footLabel);
    footRow.appendChild(buildStatCell(grand.completed, grandRefs.completed, "Whole Team \u00B7 Completed"));
    footRow.appendChild(buildStatCell(grand.pending, grandRefs.pending, "Whole Team \u00B7 Pending"));
    footRow.appendChild(buildStatCell(grand.onHold, grandRefs.onHold, "Whole Team \u00B7 On Hold"));
    footRow.appendChild(buildStatCell(grand.rejected, grandRefs.rejected, "Whole Team \u00B7 Rejected"));
    const grandAllRefs = grandRefs.completed.concat(grandRefs.pending, grandRefs.onHold, grandRefs.rejected);
    footRow.appendChild(buildStatCell(grand.total, grandAllRefs, "Whole Team \u00B7 All statuses"));
    tfoot.appendChild(footRow);
    table.appendChild(tfoot);

    return table;
  }

  function buildDashEditorCard(name, data) {
    const card = document.createElement("div");
    card.className = "dp-dash-editor-card";

    const header = document.createElement("div");
    header.className = "dp-dash-editor-header";
    const nameEl = document.createElement("span");
    nameEl.className = "dp-dash-editor-name";
    nameEl.textContent = name;
    header.appendChild(nameEl);
    const totalEl = document.createElement("span");
    totalEl.className = "dp-dash-editor-total";
    totalEl.textContent = `Total: ${data.total}`;
    header.appendChild(totalEl);
    card.appendChild(header);

    if (data.latest) {
      const latestEl = document.createElement("div");
      latestEl.className = "dp-dash-editor-latest";
      const bedLabel = bedroomChipLabel(data.latest.bedBucket) + (data.latest.bedBucket === "?" ? "" : " Bed");
      const latestBits = [data.latest.ref || "—"];
      if (BED_TRACKED_CATEGORIES.includes(data.latest.crmStatus)) latestBits.push(bedLabel);
      latestBits.push(data.latest.crmStatus, fmtRelative(data.latest.assignedAt));
      latestEl.textContent = `Latest: ${latestBits.join(" \u00B7 ")}`;
      card.appendChild(latestEl);
    }

    card.appendChild(buildCategoryStatusTable(data.categories, name));
    appendBedTableIfAny(card, data.categories);

    return card;
  }

  function buildTeamOverviewCard(team) {
    const card = document.createElement("div");
    card.className = "dp-dash-editor-card dp-dash-team-card";

    const header = document.createElement("div");
    header.className = "dp-dash-editor-header";
    const nameEl = document.createElement("span");
    nameEl.className = "dp-dash-editor-name";
    nameEl.textContent = "Whole Team";
    header.appendChild(nameEl);
    const totalEl = document.createElement("span");
    totalEl.className = "dp-dash-editor-total";
    totalEl.textContent = `Total: ${team.total}`;
    header.appendChild(totalEl);
    card.appendChild(header);

    card.appendChild(buildCategoryStatusTable(team.categories, "Whole Team"));
    appendBedTableIfAny(card, team.categories);

    return card;
  }

  // Listings put on hold before anyone was assigned — not part of any
  // editor's workload, so tracked separately rather than folded into a
  // person's numbers or silently left out of the dashboard entirely.
  function buildUnassignedCard(data) {
    const card = document.createElement("div");
    card.className = "dp-dash-editor-card dp-dash-unassigned-card";

    const header = document.createElement("div");
    header.className = "dp-dash-editor-header";
    const nameEl = document.createElement("span");
    nameEl.className = "dp-dash-editor-name";
    nameEl.textContent = "Unassigned (On Hold)";
    header.appendChild(nameEl);
    const totalEl = document.createElement("span");
    totalEl.className = "dp-dash-editor-total";
    totalEl.textContent = `Total: ${data.total}`;
    header.appendChild(totalEl);
    card.appendChild(header);

    if (data.latest) {
      const latestEl = document.createElement("div");
      latestEl.className = "dp-dash-editor-latest";
      const bedLabel = bedroomChipLabel(data.latest.bedBucket) + (data.latest.bedBucket === "?" ? "" : " Bed");
      const bits = [data.latest.ref || "—"];
      if (BED_TRACKED_CATEGORIES.includes(data.latest.crmStatus)) bits.push(bedLabel);
      bits.push(data.latest.crmStatus, fmtRelative(data.latest.assignedAt));
      latestEl.textContent = `Latest: ${bits.join(" \u00B7 ")}`;
      card.appendChild(latestEl);
    }

    card.appendChild(buildCategoryStatusTable(data.categories, "Unassigned (On Hold)"));
    appendBedTableIfAny(card, data.categories);

    return card;
  }

  // Tracks the running clock's stop function across calls, in case this
  // modal is ever reopened while a previous instance's overlay gets force-
  // removed below (bypassing its own close handlers) — without this the
  // old setInterval would keep ticking in the background forever.
  let activeDashClockStop = null;

  function showDashboardModal() {
    if (activeDashClockStop) { activeDashClockStop(); activeDashClockStop = null; }
    document.querySelector(".dp-modal-overlay") && document.querySelector(".dp-modal-overlay").remove();
    // scope: "today" | "yesterday" | "week" | "all" | { type: "custom", start, end }
    let scope = "today";
    // Remembers the last-picked dates so reopening Custom Range restores them
    // instead of starting blank.
    let customDraft = { start: "", end: "" };

    const overlay = document.createElement("div");
    overlay.className = "dp-modal-overlay";
    overlay.addEventListener("click", e => { if (e.target === overlay) closeDashboard(); });

    function closeDashboard() {
      stopClock();
      if (activeDashClockStop === stopClock) activeDashClockStop = null;
      overlay.remove();
    }

    const modal = document.createElement("div");
    modal.className = "dp-modal dp-dash-modal";
    overlay.appendChild(modal);

    const titleEl = document.createElement("h3");
    titleEl.className = "dp-modal-title";
    titleEl.textContent = "Assignment Dashboard";
    modal.appendChild(titleEl);

    const scopeRow = document.createElement("div");
    scopeRow.className = "dp-dash-scope-toggle";
    const todayBtn = Object.assign(document.createElement("button"), {
      type: "button", className: "dp-sort-btn is-active", textContent: "Today"
    });
    const yesterdayBtn = Object.assign(document.createElement("button"), {
      type: "button", className: "dp-sort-btn", textContent: "Yesterday"
    });
    const thisWeekBtn = Object.assign(document.createElement("button"), {
      type: "button", className: "dp-sort-btn", textContent: "This Week"
    });
    const weekBtn = Object.assign(document.createElement("button"), {
      type: "button", className: "dp-sort-btn", textContent: "Last 7 Days"
    });
    const monthBtn = Object.assign(document.createElement("button"), {
      type: "button", className: "dp-sort-btn", textContent: "Month"
    });
    const allBtn = Object.assign(document.createElement("button"), {
      type: "button", className: "dp-sort-btn", textContent: "All time"
    });
    const customBtn = Object.assign(document.createElement("button"), {
      type: "button", className: "dp-sort-btn", textContent: "Custom Range"
    });
    scopeRow.appendChild(todayBtn);
    scopeRow.appendChild(yesterdayBtn);
    scopeRow.appendChild(thisWeekBtn);
    scopeRow.appendChild(weekBtn);
    scopeRow.appendChild(monthBtn);
    scopeRow.appendChild(allBtn);
    scopeRow.appendChild(customBtn);
    modal.appendChild(scopeRow);

    // Inline date-range panel — hidden until "Custom Range" is clicked.
    const customPanel = document.createElement("div");
    customPanel.style.gap = "8px";
    customPanel.style.alignItems = "center";
    customPanel.style.margin = "10px 0 0";
    customPanel.style.flexWrap = "wrap";
    customPanel.style.display = "none"; // toggled to "flex" when shown
    const startInput = Object.assign(document.createElement("input"), { type: "date" });
    const endInput = Object.assign(document.createElement("input"), { type: "date" });
    [startInput, endInput].forEach(inp => {
      inp.style.background = "transparent";
      inp.style.color = "inherit";
      inp.style.border = "1px solid currentColor";
      inp.style.borderRadius = "6px";
      inp.style.padding = "4px 8px";
      inp.style.font = "inherit";
      inp.style.colorScheme = "dark";
    });
    const toLabel = document.createElement("span");
    toLabel.textContent = "to";
    const applyRangeBtn = Object.assign(document.createElement("button"), {
      type: "button", className: "dp-sort-btn", textContent: "Apply"
    });
    customPanel.appendChild(startInput);
    customPanel.appendChild(toLabel);
    customPanel.appendChild(endInput);
    customPanel.appendChild(applyRangeBtn);
    modal.appendChild(customPanel);

    // Shows the concrete date (or date range) the current scope resolves
    // to — e.g. "Mon, Jul 20, 2026" for Today, "Jul 14 – Jul 20, 2026" for
    // This Week — so it's never ambiguous what dates the numbers cover.
    // A live clock ticks alongside it so the modal always shows the
    // current wall-clock time, independent of whatever scope is selected.
    const dateInfoEl = document.createElement("div");
    dateInfoEl.className = "dp-dash-date-info";
    dateInfoEl.style.opacity = "0.7";
    dateInfoEl.style.fontSize = "0.85em";
    dateInfoEl.style.margin = "8px 0 0";
    const dateTextEl = document.createElement("span");
    dateTextEl.className = "dp-dash-date-text";
    const clockEl = document.createElement("span");
    clockEl.className = "dp-dash-clock";
    dateInfoEl.appendChild(dateTextEl);
    dateInfoEl.appendChild(document.createTextNode(" \u00B7 "));
    dateInfoEl.appendChild(clockEl);
    modal.appendChild(dateInfoEl);

    let clockTimer = null;
    function tickClock() {
      clockEl.textContent = new Date().toLocaleTimeString(undefined, {
        hour: "numeric", minute: "2-digit", second: "2-digit",
      });
    }
    function startClock() {
      tickClock();
      if (clockTimer) clearInterval(clockTimer);
      clockTimer = setInterval(tickClock, 1000);
    }
    function stopClock() {
      if (clockTimer) { clearInterval(clockTimer); clockTimer = null; }
    }

    // Quick Report — a compact per-editor Completed/Pending/On Hold/
    // Rejected/Total table, sitting right under the date so the headline
    // numbers are visible before scrolling into the detailed cards below.
    const quickReportEl = document.createElement("div");
    quickReportEl.className = "dp-dash-quick-report";
    modal.appendChild(quickReportEl);

    const summaryEl = document.createElement("div");
    summaryEl.className = "dp-dash-summary";
    modal.appendChild(summaryEl);

    const body = document.createElement("div");
    body.className = "dp-dash-body";
    modal.appendChild(body);

    function fmtFullDate(d) {
      return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" });
    }
    function fmtShortDate(d, includeYear) {
      const opts = { month: "short", day: "numeric" };
      if (includeYear) opts.year = "numeric";
      return d.toLocaleDateString(undefined, opts);
    }
    // Resolves the current scope to the human-readable date text shown
    // under the scope buttons. Returns "" for "all" (no single date makes
    // sense) or an incomplete custom range.
    function dateInfoText(s) {
      if (s === "all") return "";
      const range = scopeToRange(s);
      if (!range) return "";
      const startDate = range[0];
      const endDate = addDays(range[1], -1); // range end is exclusive
      if (s === "today" || s === "yesterday") return fmtFullDate(startDate);
      const sameYear = startDate.getFullYear() === endDate.getFullYear();
      return `${fmtShortDate(startDate, !sameYear)} – ${fmtShortDate(endDate, true)}`;
    }

    const trackedCategoriesText = `(${CATEGORY_OPTIONS.join(", ")})`;
    function scopeLabelText(s) {
      if (s === "today") return "assigned today";
      if (s === "yesterday") return "assigned yesterday";
      if (s === "thisWeek") return "assigned this week (Mon–Sun)";
      if (s === "week") return "assigned in the last 7 days";
      if (s === "month") return "assigned this month (month-to-date)";
      if (s === "all") return "assigned (all time)";
      if (s && s.type === "custom") return `assigned from ${s.start} to ${s.end}`;
      return "assigned";
    }
    function emptyLabelText(s) {
      const suffix = `in one of the tracked categories ${trackedCategoriesText}.`;
      if (s === "today") return `No listings assigned or put on hold today ${suffix}`;
      if (s === "yesterday") return `No listings assigned or put on hold yesterday ${suffix}`;
      if (s === "thisWeek") return `No listings assigned or put on hold this week ${suffix}`;
      if (s === "week") return `No listings assigned or put on hold in the last 7 days ${suffix}`;
      if (s === "month") return `No listings assigned or put on hold this month (month-to-date) ${suffix}`;
      if (s === "all") return `No assigned or on-hold listings found ${suffix}`;
      if (s && s.type === "custom") return `No listings assigned or put on hold in that date range ${suffix}`;
      return `No listings found ${suffix}`;
    }

    function render() {
      todayBtn.classList.toggle("is-active", scope === "today");
      yesterdayBtn.classList.toggle("is-active", scope === "yesterday");
      weekBtn.classList.toggle("is-active", scope === "week");
      thisWeekBtn.classList.toggle("is-active", scope === "thisWeek");
      monthBtn.classList.toggle("is-active", scope === "month");
      allBtn.classList.toggle("is-active", scope === "all");
      customBtn.classList.toggle("is-active", scope && scope.type === "custom");

      const dateText = dateInfoText(scope);
      dateTextEl.textContent = dateText;
      dateInfoEl.style.display = dateText ? "block" : "none";

      // A custom range with an incomplete or invalid date pair falls back to
      // showing nothing rather than silently rendering "all time".
      if (scope && scope.type === "custom" && !scopeToRange(scope)) {
        summaryEl.textContent = "Pick a start and end date, then Apply.";
        quickReportEl.innerHTML = "";
        body.innerHTML = "";
        return;
      }

      const { byEditor, team, unassigned, fromDomFallback, uncategorized } = computeDashboardStats(scope);
      const editorNames = Object.keys(byEditor).sort((a, b) => byEditor[b].total - byEditor[a].total);

      quickReportEl.innerHTML = "";
      if (editorNames.length > 0) {
        const qrHeading = document.createElement("div");
        qrHeading.className = "dp-dash-subheading";
        qrHeading.textContent = "Quick Report";
        quickReportEl.appendChild(qrHeading);
        quickReportEl.appendChild(buildQuickReportTable(byEditor, editorNames));
      }

      let summary =
        `${team.total} assigned listing${team.total === 1 ? "" : "s"} ${scopeLabelText(scope)} ` +
        `across the ${CATEGORY_OPTIONS.length} tracked categories ${trackedCategoriesText}`;
      if (unassigned.total > 0) {
        summary += `, plus ${unassigned.total} unassigned listing${unassigned.total === 1 ? "" : "s"} on hold`;
      }
      summary += ` — data pulled from the sheet, not limited to what's loaded on this page.`;
      if (fromDomFallback > 0) {
        summary += ` ${fromDomFallback} listing${fromDomFallback === 1 ? "" : "s"} used live page data ` +
          `(not yet synced to the sheet).`;
      }
      if (uncategorized > 0) {
        summary += ` ${uncategorized} listing${uncategorized === 1 ? "" : "s"} excluded — not one of the ` +
          `${CATEGORY_OPTIONS.length} tracked categories, or the category was never captured.`;
      }
      summaryEl.textContent = summary;

      body.innerHTML = "";

      if (editorNames.length === 0 && unassigned.total === 0) {
        const empty = document.createElement("div");
        empty.className = "dp-history-empty";
        empty.textContent = emptyLabelText(scope);
        body.appendChild(empty);
        return;
      }

      if (team.total > 0) body.appendChild(buildTeamOverviewCard(team));
      if (unassigned.total > 0) body.appendChild(buildUnassignedCard(unassigned));
      editorNames.forEach(name => body.appendChild(buildDashEditorCard(name, byEditor[name])));
    }

    function selectScope(next) {
      scope = next;
      customPanel.style.display = scope && scope.type === "custom" ? "flex" : "none";
      render();
    }

    todayBtn.addEventListener("click", () => selectScope("today"));
    yesterdayBtn.addEventListener("click", () => selectScope("yesterday"));
    weekBtn.addEventListener("click", () => selectScope("week"));
    thisWeekBtn.addEventListener("click", () => selectScope("thisWeek"));
    monthBtn.addEventListener("click", () => selectScope("month"));
    allBtn.addEventListener("click", () => selectScope("all"));
    customBtn.addEventListener("click", () => {
      startInput.value = customDraft.start;
      endInput.value = customDraft.end;
      selectScope({ type: "custom", start: customDraft.start, end: customDraft.end });
    });
    applyRangeBtn.addEventListener("click", () => {
      customDraft = { start: startInput.value, end: endInput.value };
      selectScope({ type: "custom", start: customDraft.start, end: customDraft.end });
    });

    const btnRow = document.createElement("div");
    btnRow.className = "dp-modal-btns";
    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "dp-modal-cancel";
    closeBtn.textContent = "Close";
    closeBtn.addEventListener("click", closeDashboard);
    btnRow.appendChild(closeBtn);
    modal.appendChild(btnRow);

    document.body.appendChild(overlay);
    render();
    startClock();
    activeDashClockStop = stopClock;
  }

  // ── History modal ────────────────────────────────────────────────────────
  function fmtDT(iso) {
    if (!iso) return null;
    const d = new Date(iso);
    if (isNaN(d)) return null;
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) +
      " · " + d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
  }

  function showHistoryModal(ref, refCode, title) {
    document.querySelector(".dp-modal-overlay") && document.querySelector(".dp-modal-overlay").remove();

    const overlay = document.createElement("div");
    overlay.className = "dp-modal-overlay";
    overlay.addEventListener("click", e => { if (e.target === overlay) overlay.remove(); });

    const modal = document.createElement("div");
    modal.className = "dp-modal dp-history-modal";
    overlay.appendChild(modal);

    // Header (always shown immediately)
    const header = document.createElement("div");
    header.className = "dp-history-header";
    const titleEl = document.createElement("h3");
    titleEl.className = "dp-modal-title";
    titleEl.textContent = "Time History";
    header.appendChild(titleEl);
    if (refCode || title) {
      const sub = document.createElement("div");
      sub.className = "dp-history-sub";
      sub.textContent = [refCode, title].filter(Boolean).join(" \u00b7 ");
      header.appendChild(sub);
    }
    modal.appendChild(header);

    // Body area — starts with a loading state
    const body = document.createElement("div");
    body.className = "dp-history-body";
    const loadingEl = document.createElement("div");
    loadingEl.className = "dp-history-loading";
    loadingEl.textContent = "Loading\u2026";
    body.appendChild(loadingEl);
    modal.appendChild(body);

    // Close button
    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "dp-modal-cancel";
    closeBtn.style.marginTop = "16px";
    closeBtn.textContent = "Close";
    closeBtn.addEventListener("click", () => overlay.remove());
    modal.appendChild(closeBtn);

    document.body.appendChild(overlay);

    // Renders the timeline from a given entry (or null for the empty
    // state) — pulled out into its own function so both the instant
    // in-memory path and the network-fallback path below can share it.
    function renderTimeline(entry) {
      body.innerHTML = "";

      const timeline = document.createElement("div");
      timeline.className = "dp-timeline";

      // ── Event type → visual metadata ────────────────────────────────
      // Every status-changing write on the server (assign/reassign,
      // unassign, start, complete, reject, hold, download, restart,
      // recategorize) always appends a matching entry to the raw History
      // log alongside whatever flat column(s) it updates. That makes the
      // raw log the one place a listing's FULL history survives across
      // every cycle — unlike the flat "AtColumn" fields (assignedAt,
      // rejectedAt, etc.), which only ever reflect the CURRENT row and go
      // blank/wrong the moment a listing is reopened into a fresh row
      // (see restartRejected/reopenOnCategoryChange, both of which
      // deliberately clear those columns on the new row). This is why the
      // timeline below is built from entry.history as its primary source.
      const TIMELINE_EVENT_META = {
        assigned:           { label: "Assigned",        color: "#e6941a", dot: "assigned" },
        reassigned:         { label: "Reassigned",       color: "#f472b6", dot: "reassigned" },
        unassigned:         { label: "Unassigned",       color: "#9ca3af", dot: "unassigned" },
        started:            { label: "Started",          color: "#00d1b2", dot: "started" },
        onhold:             { label: "On Hold",          color: "#b39ddb", dot: "onhold" },
        completed:          { label: "Completed",        color: "#4ade80", dot: "completed" },
        rejected:           { label: "Rejected",         color: "#ef9a9a", dot: "rejected" },
        restarted:          { label: "Restarted",        color: "#fbbf24", dot: "restarted" },
        downloaded:         { label: "Downloaded",       color: "#60a5fa", dot: "downloaded" },
        downloaded_cleared: { label: "Download Cleared", color: "#9ca3af", dot: "downloaded_cleared" },
        recategorized:      { label: "Recategorized",    color: "#fbbf24", dot: "recategorized" },
      };

      function historyEventDetail(e) {
        switch (e.type) {
          case "assigned":
            return [e.editor ? `To: ${e.editor}` : null, e.by ? `By: ${e.by}` : null]
              .filter(Boolean).join("  \u00b7  ") || null;
          case "reassigned":
            return [e.from && e.to ? `${e.from} \u2192 ${e.to}` : null, e.by ? `By: ${e.by}` : null]
              .filter(Boolean).join("  \u00b7  ") || null;
          case "unassigned":
            return [e.editor ? `From: ${e.editor}` : null, e.reason || null]
              .filter(Boolean).join("  \u00b7  ") || null;
          case "onhold":
            return e.reason ? `Reason: ${e.reason}` : null;
          case "restarted":
            return e.by ? `By: ${e.by}` : null;
          case "downloaded":
            return e.editor ? `By: ${e.editor}` : null;
          case "downloaded_cleared":
            return e.reason || null;
          case "recategorized":
            return e.from && e.to ? `${e.from} \u2192 ${e.to}` : null;
          default:
            return null;
        }
      }

      const historyLog = Array.isArray(entry && entry.history) ? entry.history : [];

      let activeEvents;
      if (historyLog.length > 0) {
        activeEvents = historyLog
          .filter(e => e && e.type && e.ts && TIMELINE_EVENT_META[e.type])
          .map(e => ({ ...TIMELINE_EVENT_META[e.type], ts: e.ts, detail: historyEventDetail(e) }))
          .sort((a, b) => new Date(a.ts) - new Date(b.ts));
      } else {
        // Legacy fallback — only reached for a row that predates this file
        // always logging history alongside every write, so there's no log
        // to read at all. Reconstructs what it can from the flat
        // "AtColumn" snapshot instead. Necessarily single-cycle only —
        // that's all a flat snapshot can ever represent — which matches
        // what a row this old actually is.
        const legacyEvents = [
          { key: "assignedAt", label: "Assigned", color: "#e6941a", dot: "assigned",
            detail: entry ? [entry.editor ? `To: ${entry.editor}` : null,
                             entry.assignedBy ? `By: ${entry.assignedBy}` : null]
                            .filter(Boolean).join("  \u00b7  ") || null : null },
          { key: "startedAt", label: "Started", color: "#00d1b2", dot: "started", detail: null },
          { key: "onHoldAt", label: "On Hold", color: "#b39ddb", dot: "onhold",
            detail: entry && entry.onHoldReason ? `Reason: ${entry.onHoldReason}` : null },
          { key: "completedAt", label: "Completed", color: "#4ade80", dot: "completed", detail: null },
          { key: "rejectedAt", label: "Rejected", color: "#ef9a9a", dot: "rejected", detail: null },
          { key: "downloadedAt", label: "Downloaded", color: "#60a5fa", dot: "downloaded", detail: null },
        ];
        const legacyReassign = (entry && entry.reassignedAt) ? [{
          label: "Reassigned", color: "#f472b6", dot: "reassigned", ts: entry.reassignedAt,
          detail: [entry.reassignedFrom && entry.reassignedTo
                     ? `${entry.reassignedFrom} \u2192 ${entry.reassignedTo}` : null,
                   entry.reassignedBy ? `By: ${entry.reassignedBy}` : null]
                    .filter(Boolean).join("  \u00b7  ") || null,
        }] : [];
        activeEvents = [
          ...legacyEvents.map(ev => ({ ...ev, ts: entry && entry[ev.key] ? entry[ev.key] : null })),
          ...legacyReassign,
        ].filter(ev => ev.ts).sort((a, b) => new Date(a.ts) - new Date(b.ts));
      }

      if (activeEvents.length === 0) {
        const empty = document.createElement("div");
        empty.className = "dp-history-empty";
        empty.textContent = "No history tracked yet for this listing.";
        timeline.appendChild(empty);
      } else {
        activeEvents.forEach((ev, i) => {
          const row = document.createElement("div");
          row.className = "dp-timeline-row";

          const dotWrap = document.createElement("div");
          dotWrap.className = "dp-timeline-dot-wrap";
          const dot = document.createElement("div");
          dot.className = `dp-timeline-dot dp-dot-${ev.dot}`;
          // Set inline too, not just via the dp-dot-* class — the two
          // newest event types (restarted/unassigned) may not have a
          // matching color rule in the stylesheet yet, and this way the
          // dot is always correctly colored regardless.
          dot.style.background = ev.color;
          dotWrap.appendChild(dot);
          if (i < activeEvents.length - 1) {
            const line = document.createElement("div");
            line.className = "dp-timeline-line";
            dotWrap.appendChild(line);
          }
          row.appendChild(dotWrap);

          const content = document.createElement("div");
          content.className = "dp-timeline-content";
          const labelEl = document.createElement("span");
          labelEl.className = "dp-timeline-label";
          labelEl.textContent = ev.label;
          labelEl.style.color = ev.color;
          content.appendChild(labelEl);
          const timeEl = document.createElement("span");
          timeEl.className = "dp-timeline-time";
          timeEl.textContent = fmtDT(ev.ts);
          content.appendChild(timeEl);
          if (ev.detail) {
            const detailEl = document.createElement("span");
            detailEl.className = "dp-timeline-detail";
            detailEl.textContent = ev.detail;
            content.appendChild(detailEl);
          }
          row.appendChild(content);
          timeline.appendChild(row);
        });
      }

      body.appendChild(timeline);
    }

    // Instant path — this exact data (every field the timeline above
    // reads) is already sitting in assignmentCache from the regular 15s
    // poll. This is what was taking 10-60s before: a raw fetch() straight
    // to Apps Script for the ENTIRE assignments sheet, with no timeout at
    // all, every single time the modal opened — even though nothing here
    // needed data that wasn't already in memory. No network call, no
    // loading state needed, in the common case.
    if (ref && assignmentCache[ref]) {
      console.log(`DP History: using in-memory data for ref="${ref}" — no fetch needed`);
      renderTimeline(assignmentCache[ref]);
      return;
    }

    // Fallback — only reached for a ref the local cache genuinely doesn't
    // have yet (e.g. brand new, first poll hasn't landed). Routed through
    // the same timeout-protected message channel every other request in
    // this file uses, instead of a raw fetch with no cutoff at all.
    console.log(`DP History: "${ref}" not in local cache yet, falling back to a fresh fetch`);
    safeSendMessage({ type: "DP_GET_ALL" }, resp => {
      if (!(resp && resp.ok && resp.data && Array.isArray(resp.data.assignments))) {
        body.innerHTML = "";
        const errEl = document.createElement("div");
        errEl.className = "dp-history-empty";
        errEl.textContent = `Could not load history: ${(resp && resp.error) || "unknown error"}`;
        body.appendChild(errEl);
        return;
      }

      // Last match, not first — same reasoning as the write-verification
      // fix above: the current cycle's row is always the last one appended
      // for a given Ref.
      const match = resp.data.assignments.filter(a => a.ref === ref).pop();
      if (match && ref) {
        assignmentCache[ref] = {
          editor:         match.editor         || "",
          status:         match.status         || "",
          title:          match.title          || "",
          assignedAt:     match.assignedAt     || "",
          startedAt:      match.startedAt      || "",
          completedAt:    match.completedAt    || "",
          rejectedAt:     match.rejectedAt     || "",
          onHoldAt:       match.onHoldAt       || "",
          onHoldReason:   match.onHoldReason   || "",
          assignedBy:     match.assignedBy     || "",
          reassignedFrom: match.reassignedFrom || "",
          reassignedTo:   match.reassignedTo   || "",
          reassignedBy:   match.reassignedBy   || "",
          reassignedAt:   match.reassignedAt   || "",
          bedrooms:       match.bedrooms        || "",
          crmStatus:      match.crmStatus       || "",
          downloadedAt:   match.downloadedAt    || "",
          history:        Array.isArray(match.history) ? match.history : [],
          listingRef:     match.listingRef      || "",
        };
      }
      renderTimeline(match || null);
    });
  }

  function extractDetailPageRef() {
    const el = document.querySelector(".ref-side-drawer-res-design");
    return el ? el.textContent.trim() : null;
  }
  function findCompleteButton(target) {
    const btn = target && target.closest && target.closest("button.custom-dropdown-trigger.are-action.is-wide");
    if (!btn) return null;
    const span = btn.querySelector("span");
    return span && span.textContent.trim() === "Complete" ? btn : null;
  }

  // ── Backup Complete button injected into the side drawer ─────────────────
  // Some listings never get the CRM's own "Complete" dropdown action inside
  // the detail drawer (e.g. a reshoot that only replaces photos). Rather
  // than always showing our own Complete button, we check the open drawer
  // for the native one first — if it's there, the click hook below already
  // handles it and we do nothing. Only if it's genuinely missing do we
  // inject our own button in the same toolbar spot.
  function hasNativeCompleteButton(actionsEl) {
    const buttons = actionsEl.querySelectorAll("button.custom-dropdown-trigger.are-action.is-wide");
    for (const btn of buttons) {
      const span = btn.querySelector("span");
      const text = span && span.textContent.trim();
      if (text === "Complete" || text === "Approve") return true;
    }
    return false;
  }

  function completeFromDrawer(ref, btn) {
    if (!window.dpRequireName()) return;
    const previousEntry = assignmentCache[ref] || null;
    const editor = previousEntry ? previousEntry.editor || "" : "";
    const title  = previousEntry ? previousEntry.title  || "" : "";
    assignmentCache[ref] = { ...(previousEntry || {}), editor, status: "Completed", title,
      completedAt: new Date().toISOString() };
    lastLocalChangeAt[ref] = Date.now();
    document.querySelectorAll(".dp-assign-cell").forEach(c => {
      if (c.dataset.dpRef === ref) {
        c.dataset.dpAppliedStatus = "Completed";
        c.__dpRenderStatus && c.__dpRenderStatus();
      }
    });
    btn.disabled = true;
    btn.textContent = "Completing…";
    safeSendMessage({ type: "DP_MARK_COMPLETED", ref, editor, title }, resp => {
      if (resp && resp.ok) {
        btn.textContent = "Completed \u2713";
      } else {
        console.log("DP drawer markCompleted failed", resp);
        verifyBeforeReverting(ref, "Completed", () => {
          if (previousEntry) assignmentCache[ref] = previousEntry;
          else delete assignmentCache[ref];
          lastLocalChangeAt[ref] = Date.now();
          document.querySelectorAll(".dp-assign-cell").forEach(c => {
            if (c.dataset.dpRef === ref) {
              c.dataset.dpAppliedStatus = previousEntry ? previousEntry.status || "" : "";
              c.__dpRenderStatus && c.__dpRenderStatus();
            }
          });
          btn.disabled = false;
          btn.textContent = "Complete";
        }, "Could not mark Completed — try again.");
      }
    });
  }

  function ensureDrawerCompleteButton() {
    const toolbar = document.querySelector(".side-drawer-body-head .preview-toolbar");
    if (!toolbar) return;
    const actions = toolbar.querySelector(".preview-actions");
    if (!actions) return;

    const ref = extractDetailPageRef();
    let existingOurs = actions.querySelector("#dp-drawer-complete-btn");

    // Drawer switched to a different listing without a full DOM remount —
    // drop the stale button so it gets re-evaluated for the new listing.
    if (existingOurs && existingOurs.dataset.dpRef !== ref) {
      existingOurs.remove();
      existingOurs = null;
    }

    if (hasNativeCompleteButton(actions)) {
      if (existingOurs) existingOurs.remove();
      return;
    }
    if (existingOurs || !ref) return;

    // Already completed in our records — no need to offer it again.
    const cached = assignmentCache[ref];
    if (cached && cached.status === "Completed") return;

    const btn = document.createElement("button");
    btn.type = "button";
    btn.id = "dp-drawer-complete-btn";
    btn.className = "dp-drawer-complete-btn";
    btn.dataset.dpRef = ref;
    btn.textContent = "Complete";
    btn.title = "No native Complete action found on this listing (e.g. reshoots) — manually mark it Completed";
    btn.addEventListener("click", guarded(e => {
      e.stopPropagation();
      e.preventDefault();
      completeFromDrawer(ref, btn);
    }));

    const closeBtn = actions.querySelector(".preview-close-button");
    if (closeBtn) actions.insertBefore(btn, closeBtn);
    else actions.appendChild(btn);
  }

  // ── Assignment card injected into the side drawer's right sidebar ────────
  // Adds a "Photo Assignment" card (same look as the CRM's own Notes /
  // Recent Activities cards) into the detail drawer, containing the exact
  // same Assignment widget used on list rows — status pill, Start/Hold,
  // Drive/History/Copy-ref buttons, Downloaded checkbox. Because the sheet-
  // sync loops elsewhere in this file match cells purely by
  // cell.dataset.dpRef (not by DOM ancestry), this cell is automatically
  // kept live by the same code that updates the list-row widgets.
  function extractDrawerRefCode() {
    const el = document.querySelector(".ref-pocket .reference-preview");
    return el ? el.textContent.trim() : null;
  }
  function extractDrawerCrmStatus() {
    const el = document.querySelector(".ref-pocket > span.badge.ml-2");
    return el ? el.textContent.trim() : null;
  }
  // Best-effort — the exact heading markup for the detail panel's title
  // wasn't available when this was built, so a few likely selectors are
  // tried before falling back to the listing code. Only affects the
  // `title` value sent along with assign/complete/etc. messages, not
  // whether the widget itself works.
  function extractDrawerTitle() {
    const candidates = [".side-drawer-body h1", ".side-drawer-body h2", ".preview-title", ".request-title"];
    for (const sel of candidates) {
      const el = document.querySelector(sel);
      if (el && el.textContent.trim()) return el.textContent.trim();
    }
    return extractDrawerRefCode() || "";
  }
  function findDrawerSidebarContainer() {
    // Only treat this as "the drawer's sidebar" when a drawer is actually
    // open (guards against .sticky-page.is-sticky ever matching something
    // unrelated elsewhere on the page).
    if (!document.querySelector(".side-drawer-body-head")) return null;
    return document.querySelector(".sticky-page.is-sticky");
  }

  function ensureDrawerAssignCard() {
    const container = findDrawerSidebarContainer();
    const ref = extractDetailPageRef();

    if (!container || !ref) {
      const stale = document.getElementById("dp-drawer-assign-card");
      if (stale) stale.remove();
      return;
    }

    let card = document.getElementById("dp-drawer-assign-card");

    // Navigated to a different listing via the ‹ › arrows without a full
    // DOM remount — drop the old card so it gets rebuilt for the new ref.
    if (card && card.dataset.dpRef !== ref) {
      card.remove();
      card = null;
    }
    if (card) return; // already built for this ref — the sync loops keep it live from here

    const refCode = extractDrawerRefCode();
    const title = extractDrawerTitle();

    card = document.createElement("div");
    card.id = "dp-drawer-assign-card";
    card.className = "box is-rounded is-shadowless has-border py-4 px-4 mb-5 dp-drawer-assign-card";
    card.dataset.dpRef = ref;

    const heading = document.createElement("h3");
    heading.className = "has-text-black";
    heading.textContent = "Photo Assignment";
    card.appendChild(heading);

    const assignCell = renderAssignCell(ref, title, refCode);
    // Drop the CRM's own .table-cell class — it carries list-row-specific
    // width/display rules meant for the accordion table layout, which
    // fight with this standalone card's own width/wrap behavior.
    assignCell.classList.remove("table-cell");
    // Drop the cell's own small "Assignment" label — the h3 above already
    // serves as this card's title, matching Notes / Recent Activities.
    const innerLabel = assignCell.querySelector("label");
    if (innerLabel) innerLabel.remove();
    card.appendChild(assignCell);

    const anchor = container.querySelector(".box.is-rounded.pb-5.px-5.is-hidden-mobile.handleCursor");
    if (anchor && anchor.parentElement === container) {
      anchor.insertAdjacentElement("afterend", card);
    } else {
      container.insertBefore(card, container.firstChild);
    }
  }

  document.addEventListener("click", guarded(e => {
    if (!findCompleteButton(e.target)) return;
    const ref = extractDetailPageRef();
    if (!ref) return;
    if (!window.dpRequireName()) return;
    const previousEntry = assignmentCache[ref] || null;
    const editor = previousEntry ? previousEntry.editor || "" : "";
    const title  = previousEntry ? previousEntry.title  || "" : "";
    assignmentCache[ref] = { editor, status: "Completed", title, completedAt: new Date().toISOString(),
      bedrooms: (previousEntry && previousEntry.bedrooms) || "",
      crmStatus: (previousEntry && previousEntry.crmStatus) || "" };
    lastLocalChangeAt[ref] = Date.now();
    document.querySelectorAll(".dp-assign-cell").forEach(c => {
      if (c.dataset.dpRef === ref) {
        c.dataset.dpAppliedStatus = "Completed";
        c.__dpRenderStatus && c.__dpRenderStatus();
      }
    });
    safeSendMessage({ type: "DP_MARK_COMPLETED", ref, editor, title }, resp => {
      if (!(resp && resp.ok)) {
        console.log("DP mark-completed failed", resp);
        verifyBeforeReverting(ref, "Completed", () => {
          if (previousEntry) assignmentCache[ref] = previousEntry;
          else delete assignmentCache[ref];
          lastLocalChangeAt[ref] = Date.now();
          document.querySelectorAll(".dp-assign-cell").forEach(c => {
            if (c.dataset.dpRef === ref) {
              c.dataset.dpAppliedStatus = previousEntry ? previousEntry.status || "" : "";
              c.__dpRenderStatus && c.__dpRenderStatus();
            }
          });
        }, "Could not mark Completed — reverted.");
      }
    });
  }), true);

  // Reject modal Submit interceptor — same pattern as the Copier's version.
  // The CRM's own "Reject" dropdown button just opens their modal (reason
  // textarea + Cancel/Submit); clicking it doesn't mean the rejection is
  // final. We don't hook that outer button — that would mark the listing
  // Rejected even if the person cancels out of the modal. Instead this
  // fires only when their modal's own "Submit" button is actually clicked,
  // confirmed by checking the modal's heading text and the presence of
  // its reason textarea, not just button text.
  document.addEventListener("click", guarded(e => {
    const btn = e.target && e.target.closest && e.target.closest("button");
    if (!btn) return;
    if (btn.textContent.trim().toLowerCase() !== "submit") return;

    // Confirm this Submit belongs to the CRM's Reject modal, not some
    // other modal that also happens to have a Submit button.
    const modalCard = btn.closest(".card");
    if (!modalCard) return;
    const heading = modalCard.querySelector(".card-heading h3");
    const isRejectModal = heading && heading.textContent.trim().toLowerCase() === "reject";
    const reasonField = modalCard.querySelector('textarea[name="reject_reason"]');
    if (!isRejectModal || !reasonField) return;

    const ref = extractDetailPageRef();
    if (!ref) return;
    if (!window.dpRequireName()) return;
    const previousEntry = assignmentCache[ref] || null;
    const editor = previousEntry ? previousEntry.editor || "" : "";
    const title  = previousEntry ? previousEntry.title  || "" : "";

    assignmentCache[ref] = { ...(previousEntry || {}), editor, status: "Rejected", title };
    lastLocalChangeAt[ref] = Date.now();
    document.querySelectorAll(".dp-assign-cell").forEach(c => {
      if (c.dataset.dpRef === ref) {
        c.dataset.dpAppliedStatus = "Rejected";
        c.__dpRenderStatus && c.__dpRenderStatus();
      }
    });
    safeSendMessage({ type: "DP_MARK_REJECTED", ref, editor, title }, resp => {
      if (!(resp && resp.ok)) {
        console.log("DP mark-rejected failed", resp);
        verifyBeforeReverting(ref, "Rejected", () => {
          if (previousEntry) assignmentCache[ref] = previousEntry;
          else delete assignmentCache[ref];
          lastLocalChangeAt[ref] = Date.now();
          document.querySelectorAll(".dp-assign-cell").forEach(c => {
            if (c.dataset.dpRef === ref) {
              c.dataset.dpAppliedStatus = previousEntry ? previousEntry.status || "" : "";
              c.__dpRenderStatus && c.__dpRenderStatus();
            }
          });
        }, "Could not mark Rejected — reverted.");
      }
    });
  }), true);

  // ── Open-listing-in-new-tab click interceptor ────────────────────────────
  // When the "Open in new tab" toggle is on, clicking anywhere on a listing
  // row (other than our own injected controls or a native interactive
  // element) opens that listing in a brand-new tab and switches focus to
  // it, instead of leaving it open in this tab.
  //
  // The CRM gives every open listing its own unique URL — a hash suffix
  // like #Request#vZ13PGMbXk appended after the drawer opens — but that
  // hash is assigned by the CRM's own router once the drawer actually
  // opens; it doesn't exist anywhere in the row's DOM beforehand, so we
  // can't build it ourselves ahead of the click. Instead we let the click
  // proceed normally (opening the drawer briefly in this tab), watch for
  // the URL to update to match the listing we clicked, capture that exact
  // URL, hand it to a new focused tab, and then close the drawer here so
  // this tab lands back on the list.
  document.addEventListener("click", guarded(e => {
    if (!openListingInNewTabEnabled) return;
    const row = e.target && e.target.closest && e.target.closest(".table-row.accordion");
    if (!row) return;
    // Let our own injected controls (Drive/History/Copy-ref buttons,
    // Downloaded checkbox, Assign/Hold widget) and any other native
    // interactive element behave normally instead of being hijacked.
    if (e.target.closest(".dp-assign-cell, button, input, select, textarea, a, label")) return;
    const ref = extractRef(row);
    if (!ref) return;
    // Drop the shield in this same tick, before the event even reaches the
    // CRM's own click handling below us — so the drawer it's about to open
    // never actually gets shown.
    showFlickerShield();
    captureDrawerUrlThenDuplicate(ref);
  }), true);

  // Polls (briefly) for the drawer to open for the clicked ref and its
  // unique URL hash to appear, then duplicates that exact URL into a new
  // tab and closes the drawer here. Gives up quietly after ~4s if the CRM
  // never opens a matching drawer (e.g. the click didn't actually land on
  // an openable row) — the drawer, if any, is simply left as-is in that case.
  // Either way the flicker shield always comes down before this returns.
  function captureDrawerUrlThenDuplicate(ref) {
    const deadline = Date.now() + 4000;
    const check = () => {
      if (contextDead) { hideFlickerShield(); return; }
      const liveRef = extractDetailPageRef();
      if (liveRef === ref && /#Request#/.test(location.href)) {
        const url = location.href;
        safeSendMessage({ type: "DP_OPEN_LISTING_NEW_TAB", url }, resp => {
          if (!(resp && resp.ok)) console.log("DP open-listing-in-new-tab failed", resp);
        });
        const closeBtn = document.querySelector(".side-drawer-body-head .preview-close-button");
        if (closeBtn) closeBtn.click();
        // Give the close a moment to actually settle in the DOM before
        // lifting the shield, so there's nothing left to flash on the way
        // back down either.
        setTimeout(hideFlickerShield, 200);
        return;
      }
      if (Date.now() < deadline) { setTimeout(guarded(check), 120); return; }
      // Timed out without a matching drawer ever showing up — lift the
      // shield so the person isn't staring at a frozen screen forever.
      hideFlickerShield();
    };
    setTimeout(guarded(check), 150);
  }

  document.addEventListener("click", guarded(() => closeAllPopovers()));

  const observer = new MutationObserver(guarded(() => debounceProcess()));
  observer.observe(document.body, { childList: true, subtree: true });

  // The drawer can open/switch listings via a style or class toggle rather
  // than adding/removing DOM nodes, which the childList-only observer above
  // won't catch. ensureDrawerCompleteButton()/ensureDrawerAssignCard() are a
  // cheap handful of querySelector calls each, so a lightweight poll is the
  // most reliable way to keep them in sync with whatever's currently open.
  //
  // Same reasoning applies to the row/card status border+tint: editing
  // something inside an expanded row (e.g. the Photo Gallery) can make
  // React re-render that row's DOM and reset the inline style we forced
  // onto it, without ever adding/removing a node — invisible to the
  // observer. __dpReassertVisuals is idempotent (reads from the cached
  // dataset, not a fresh argument), so re-running it here on every live
  // cell is cheap and self-heals within ~800ms regardless of what caused
  // the wipe.
  setInterval(guarded(() => {
    ensureDrawerCompleteButton();
    ensureDrawerAssignCard();
    document.querySelectorAll(".dp-assign-cell").forEach(c => {
      c.__dpReassertVisuals && c.__dpReassertVisuals();
    });
  }), 800);

  // ── Init (reads role + name from storage before starting) ───────────────
  chrome.storage.local.get(["role", "myName", "dpAssignSnapshot", "dpOpenListingNewTab"], result => {
    ROLE = (result && result.role) || "senior";
    MY_NAME = (result && result.myName) || "";
    // Default OFF — only on if explicitly turned on before. Now set from
    // the side panel's Settings drawer; kept live afterward by the
    // chrome.storage.onChanged listener further below.
    openListingInNewTabEnabled = !!(result && result.dpOpenListingNewTab === true);
    // Auto-assign is intentionally NEVER restored from a prior session —
    // every fresh page load/refresh starts with it OFF, full stop, even if
    // it was left on before (from this tab or the side panel). It has to
    // be turned back on by hand each time. We also write that OFF state
    // back to storage so the side panel's toggle reflects the same reset,
    // rather than showing "on" for a feature that's actually just gone
    // quiet in every tab.
    autoAssignEnabled = false;
    try {
      chrome.storage.local.set({ dpAutoAssignEnabled: false });
    } catch (e) {}

    // Hydrate from the last-known snapshot (saved after every successful
    // refresh — see refreshAssignments) BEFORE the first render pass runs.
    // Without this, every row starts from an empty assignmentCache and
    // renders "Unassigned" until the live Apps Script fetch below actually
    // resolves — which can take a few seconds, long enough that editors
    // have genuinely mistaken a fully-assigned board for an empty one.
    // Stale data (a snapshot older than one refresh interval) is dropped
    // rather than trusted — better to show a brief loading state than
    // confidently wrong data from an old session.
    // Staleness window is pegged to BACKGROUND_REFRESH_INTERVAL_MS (not the
    // tight 3s active-tab rate) since a tab that was backgrounded right
    // before a reload should still trust its last snapshot rather than
    // discard it over a gap that's normal, not stale.
    if (result && result.dpAssignSnapshot) {
      try {
        const snap = JSON.parse(result.dpAssignSnapshot);
        if (snap && snap.savedAt && Date.now() - snap.savedAt < BACKGROUND_REFRESH_INTERVAL_MS) {
          assignmentCache = snap.assignmentCache || {};
          downloadedCache = snap.downloadedCache || {};
        }
      } catch (e) { /* ignore malformed/old-format snapshot */ }
    }

    refreshAssignments();
    startPolling();
    document.addEventListener("visibilitychange", guarded(startPolling));
    debounceProcess();
  });

  // Restarts the poll loop at the rate matching current tab visibility.
  // Called on init and again every time visibility changes, so a
  // backgrounded tab drops to a slow keep-alive rate (freeing up quota for
  // whichever tabs are actually being watched) and snaps back to the fast
  // real-time rate the instant it's focused again — with an immediate
  // refresh on that transition so there's no stale wait after switching back.
  function startPolling() {
    if (contextDead) return;
    if (pollHandle) clearInterval(pollHandle);
    const interval = document.visibilityState === "visible"
      ? REFRESH_INTERVAL_MS
      : BACKGROUND_REFRESH_INTERVAL_MS;
    if (document.visibilityState === "visible") refreshAssignments();
    pollHandle = setInterval(guarded(refreshAssignments), interval);
  }
})();