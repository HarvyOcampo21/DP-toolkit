"use strict";

// Clicking the toolbar icon opens the side panel directly — see
// manifest.json's "side_panel" key (sidepanel.html replaces the old
// popup.html/popup.js) and the removed "default_popup" from "action".
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

// ─────────────────────────────────────────────────────────────────────────
// DP Toolkit — unified background service worker
// Combines:
//   • DP Photo Assigner  (DP_* messages)      → its own Apps Script backend
//   • DP Listing Copier  (LOG_* messages)     → its own separate Apps Script backend
// These are two independent Google Sheets / Apps Script deployments, so
// each keeps its own config block below.
// ─────────────────────────────────────────────────────────────────────────

const ASSIGNER_CONFIG = {
  // Split back out to its own dedicated Apps Script deployment + spreadsheet
  // (separate from Copier's) to remove shared execution-quota/lock
  // contention between high-frequency Assigner polling and Copier writes.
  WEB_APP_URL: "https://script.google.com/macros/s/AKfycbzpHle7iubZvZTSEtY3yUGdtQIwiFaKIQFSkRBnYFHDgYku9Gyt-Iwb30jGduddY2K0/exec",
  TOKEN: "DPPE",
};

const COPIER_APPS_SCRIPT_URL = "https://script.google.com/a/macros/drivenproperties.com/s/AKfycbxRnU165B4OZoIyc-sDFrkQB-tePNsb9MBrMWJa7IRZuTWzzITQvxT6ES7eSCVzc6S-/exec";

// Explicit exceptions for anyone whose real @drivenproperties.com address
// doesn't follow the plain {firstname}@drivenproperties.com pattern (e.g.
// two editors sharing a first name, or a different naming convention).
// Add entries here as {"ExactNameFromPopup": "actual.email@drivenproperties.com"}
// — everyone not listed falls back to the pattern automatically.
const WORK_EMAIL_OVERRIDES = {
  // "Jabir": "jabir.k@drivenproperties.com",
};

function buildWorkEmail(name) {
  if (WORK_EMAIL_OVERRIDES[name]) return WORK_EMAIL_OVERRIDES[name];
  return name.trim().toLowerCase().replace(/\s+/g, "") + "@drivenproperties.com";
}

// Shared by every request to Apps Script (both Assigner and Copier — same
// deployment). The Assigner's write lock (see appscript.js assignerDoPost)
// legitimately waits up to 30s for any other write to finish before it even
// starts — that's correct, intentional behavior, not a hang. This timeout
// must stay comfortably above that 30s so a normal lock wait never gets
// mistaken for a failure: aborting the fetch client-side does NOT cancel the
// request server-side, so a client that gives up too early doesn't stop the
// write — it just stops finding out about it, which is what was producing
// false "reverted" alerts moments before the real success toast appeared.
const FETCH_TIMEOUT_MS = 40000;

function fetchWithTimeout(url, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  return fetch(url, { ...options, signal: controller.signal })
    .finally(() => clearTimeout(timer))
    .catch(err => {
      if (err && err.name === "AbortError") {
        throw new Error(`Request timed out after ${FETCH_TIMEOUT_MS / 1000}s — Apps Script may be busy, try again shortly.`);
      }
      throw err;
    });
}

// ── Post-reload wizard tab ────────────────────────────────────────────────
// reload.js sets dpPendingPostReloadTab right before calling
// chrome.runtime.reload() — that call tears down reload.js's own execution
// context almost immediately, so nothing placed after it in that same
// script can be relied on to run. This top-level code, on the other hand,
// always runs fresh every time the service worker starts — including
// right after a reload — so it's the reliable place to pick the flag back
// up and continue the flow.
//
// Deliberately opens a brand-new reload.html tab here rather than trying
// to message a content script in an already-open CRM tab: chrome.runtime.
// reload() invalidates every content script that was already injected
// before it ran, so a message sent to one of those tabs right after the
// reload has no listener left alive to receive it. A freshly created
// extension tab doesn't have that problem — its context is guaranteed
// valid since it's created after the reload, not before it.
chrome.storage.local.get(["dpPendingPostReloadTab"], result => {
  const requestedAt = result && result.dpPendingPostReloadTab;
  if (!requestedAt) return;
  // Ignore a stale/leftover flag (e.g. from a crash before it got cleared)
  // rather than opening an unexpected tab long after the fact.
  if (Date.now() - requestedAt > 60000) {
    chrome.storage.local.remove("dpPendingPostReloadTab");
    return;
  }
  chrome.storage.local.remove("dpPendingPostReloadTab");
  chrome.tabs.create({ url: chrome.runtime.getURL("reload.html?step=post") });
});

// Role is derived from the name the person picks in the popup (see
// NAME_ROLES in popup.js) — this extension is shared by seniors and
// juniors alike, so we never hardcode everyone to "senior" here.
// On first install (before a name has been chosen) default to the safer,
// more restrictive "junior" role so nobody gets senior powers by accident.
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get(["role"], result => {
    if (!result || !result.role) chrome.storage.local.set({ role: "junior" });
  });
});

// ═══════════════════════════════════════════════════════════════════════
// LIVE ASSIGNMENT NOTIFICATIONS
// ═══════════════════════════════════════════════════════════════════════
// Chrome service workers get shut down when idle, so there's no way to
// keep a persistent connection open — instead we poll the same sheet the
// Assigner already reads from, once a minute (the shortest interval
// chrome.alarms allows), and fire a desktop notification — with the OS's
// default sound, since we don't set silent:true — the moment a NEW
// "Assigned" row shows up for whoever has picked their name in this
// browser's popup. Not instant, but effectively live (≤ ~60s lag).
const NOTIFY_ALARM_NAME = "dpPollAssignments";
const NOTIFY_POLL_MINUTES = 1;

// Re-registering with the same name just resets the existing alarm rather
// than duplicating it, so it's safe to call this every time the service
// worker wakes up — this is what keeps the alarm alive across the SW being
// shut down and restarted by Chrome.
chrome.alarms.create(NOTIFY_ALARM_NAME, { periodInMinutes: NOTIFY_POLL_MINUTES });

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === NOTIFY_ALARM_NAME) pollForNewAssignments();
});

// ref -> notification id, so a click can look up which listing to open.
const notificationRefMap = {};

async function pollForNewAssignments() {
  const { myName } = await chrome.storage.local.get(["myName"]);
  if (!myName) return; // nobody's picked a name in this browser yet

  let data;
  try {
    const res = await fetchWithTimeout(buildAssignerGetUrl());
    data = await res.json();
  } catch {
    return; // offline / sheet unreachable — just skip this tick, try again in 1 min
  }
  if (!data || data.error || !Array.isArray(data.assignments)) return;

  const mine = data.assignments.filter(a => a.editor === myName && a.status === "Assigned");
  const currentRefs = mine.map(a => a.ref);

  const store = await chrome.storage.local.get(["dpSeenAssignedRefs", "dpNotifyBaselineDone"]);

  // First poll after install (or right after picking/changing a name) —
  // just record what's currently assigned as the baseline. Without this,
  // switching your name for the first time would fire a notification for
  // every pre-existing assignment instead of only new ones going forward.
  if (!store.dpNotifyBaselineDone) {
    await chrome.storage.local.set({ dpSeenAssignedRefs: currentRefs, dpNotifyBaselineDone: true });
    return;
  }

  const seen = new Set(store.dpSeenAssignedRefs || []);
  mine.filter(a => !seen.has(a.ref)).forEach(notifyNewAssignment);

  await chrome.storage.local.set({ dpSeenAssignedRefs: currentRefs });
}

function notifyNewAssignment(assignment) {
  const notifId = `dp-assign-${assignment.ref}-${Date.now()}`;
  notificationRefMap[notifId] = assignment.ref;
  chrome.notifications.create(notifId, {
    type: "basic",
    iconUrl: "icons/icon128.png",
    title: "New Photo Request Assigned",
    message: assignment.title || assignment.ref,
    contextMessage: [
      assignment.ref,
      assignment.assignedBy ? `By: ${assignment.assignedBy}` : null,
    ].filter(Boolean).join("  \u00B7  "),
    priority: 2,
    silent: false, // explicit — lets the OS play its default notification sound
  });
}

// Clicking the notification jumps straight to the CRM and searches that
// ref — reuses the same auto-search flow as the dashboard's ref list.
chrome.notifications.onClicked.addListener(notifId => {
  const ref = notificationRefMap[notifId];
  chrome.notifications.clear(notifId);
  delete notificationRefMap[notifId];
  if (ref) handleAutoSearch(ref).catch(() => {});
});

// Explicit set rather than a "starts with DP_" check — the Large Image
// Preview tool's download/zip messages also happen to use a DP_ prefix
// (DP_DOWNLOAD_ALL, DP_DOWNLOAD_ZIP, DP_ZIP_PROGRESS) and are handled by
// their own separate listener further down this file.
const ASSIGNER_MESSAGE_TYPES = new Set([
  "DP_GET_ALL", "DP_ASSIGN", "DP_UNASSIGN", "DP_MARK_INPROGRESS",
  "DP_MARK_COMPLETED", "DP_MARK_REJECTED", "DP_SET_ON_HOLD",
  "DP_SET_DOWNLOADED", "DP_SYNC_META", "DP_OPEN_DRIVE_SEARCH",
  "DP_REOPEN_ON_RECATEGORIZE", "DP_OPEN_LISTING_NEW_TAB",
  "DP_SET_AUTO_ASSIGN_ELIGIBILITY", "DP_RESTART_REJECTED",
  "DP_RESTART_COMPLETED",
]);

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  // ── Photo Assigner messages ───────────────────────────────────────────
  if (message.type && ASSIGNER_MESSAGE_TYPES.has(message.type)) {
    return handleAssignerMessage(message, sendResponse);
  }

  // ── Listing Copier messages ───────────────────────────────────────────
  if (message.type === "LOG_TO_SHEET") {
    handleLogToSheet(message.payload)
      .then(sendResponse)
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.type === "LOG_LIFESTYLE") {
    handleLogLifestyle(message.payload)
      .then(sendResponse)
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.type === "LOG_EMAIL_CLOSED") {
    handleLogEmailClosed(message.payload)
      .then(sendResponse)
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  // ── Dashboard "click a ref → search it in the CRM" ─────────────────────
  if (message.type === "DP_AUTO_SEARCH") {
    handleAutoSearch(message.ref)
      .then(() => sendResponse({ ok: true }))
      .catch(err => sendResponse({ ok: false, error: String(err && err.message || err) }));
    return true;
  }

  // ── Auto-assign leader election ─────────────────────────────────────────
  // "First CRM tab" = tabs[0] out of every currently-open tab matching
  // /photorequest/* WITHIN THE SAME BROWSER WINDOW as the tab asking — see
  // the "independent automation per Chrome window" requirements doc for
  // why this is scoped to windowId rather than across the whole browser
  // the way it originally was. macOS Spaces are NOT separate Chrome
  // instances — they're just different desktops showing different windows
  // of the SAME browser process, so windowId is the only real unit of
  // isolation Chrome actually gives us here; a person running automation
  // in a Chrome window parked on one Space and working normally in another
  // window on a different Space needs each window's leader computed
  // independently, or the "first tab in the whole browser" from an
  // unrelated window could end up the only one ever allowed to fire, even
  // while sitting on a Space nobody's using it for automation at all.
  // Same left-to-right tab-strip ordering as before (see handleAutoSearch's
  // "second CRM tab" targeting above), just filtered to one window first.
  // No registration list to maintain: each content script just asks "is it
  // currently me, in my window?" on its own poll cadence (see
  // checkAutoAssignLeadership in assigner-content.js), and chrome.tabs.query
  // always reflects tabs that are actually open right now — a closed leader
  // tab simply stops appearing, so the next tab in that SAME window's strip
  // order becomes tabs[0] and answers "yes" on its very next check.
  if (message.type === "DP_CHECK_AUTO_ASSIGN_LEADER") {
    (async () => {
      try {
        const myTabId = _sender && _sender.tab && _sender.tab.id;
        const myWindowId = _sender && _sender.tab && _sender.tab.windowId;
        const tabs = await chrome.tabs.query({ url: CRM_REQUESTS_URL_PATTERN, windowId: myWindowId });
        const leaderTabId = tabs.length ? tabs[0].id : null;
        sendResponse({ ok: true, isLeader: myTabId != null && myTabId === leaderTabId });
      } catch (err) {
        sendResponse({ ok: false, error: String(err && err.message || err) });
      }
    })();
    return true;
  }

  // ── Window context ────────────────────────────────────────────────────
  // A content script has no direct access to chrome.tabs/chrome.windows —
  // only the background worker sees which window a message's sender.tab
  // actually belongs to — so this is how assigner-content.js learns its
  // own windowId once on load, needed to read/write the per-window-scoped
  // automation settings (dpAutoAssignEnabled:<windowId> etc.) introduced
  // alongside this handler. sidepanel.js doesn't need this: as an
  // extension page (not a content script) it can call
  // chrome.windows.getCurrent() directly.
  if (message.type === "DP_GET_CONTEXT") {
    const windowId = _sender && _sender.tab && _sender.tab.windowId;
    sendResponse({ ok: windowId != null, windowId });
    return true;
  }

  // ── Force Sync (side panel) ─────────────────────────────────────────────
  // The side panel's own Force Sync button already re-fetches its own
  // list directly — this just additionally pushes an out-of-cycle
  // refreshAssignments() into every open CRM tab, so a stale-looking board
  // in a tab that's been sitting in the background doesn't need its own
  // person to notice and manually refresh it. Best-effort per tab: a tab
  // mid-navigation (content script briefly detached) just misses this one
  // push and catches up on its own next poll a few seconds later anyway.
  if (message.type === "DP_FORCE_SYNC_ALL") {
    (async () => {
      const tabsSynced = await pushForceRefreshToCrmTabs();
      sendResponse({ ok: true, tabsSynced });
    })();
    return true;
  }

  // ── Live patch relay (instant CRM ↔ side panel sync) ────────────────────
  // The instant half of cross-surface sync — see broadcastLivePatch's own
  // comment in assigner-content.js/sidepanel.js. Fired the moment EITHER
  // surface makes a local optimistic update, well before that write's own
  // Sheet round trip even resolves, and relayed here immediately to every
  // other open CRM tab + the side panel with zero gating on anything —
  // deliberately NOT routed through postToAssignerSheet/broadcastDataChanged
  // (that pathway stays as the slower eventual-consistency backstop, gated
  // on write success, see its own comment above). Echoing back to the
  // tab/panel that sent it is harmless by design: every receiver ignores a
  // patch whose timestamp isn't newer than its own last local change for
  // that Ref (see applyLivePatch on both sides), so no "don't relay to the
  // origin" bookkeeping is needed here at all.
  if (message.type === "DP_LIVE_PATCH") {
    (async () => {
      try {
        const tabs = await chrome.tabs.query({ url: CRM_REQUESTS_URL_PATTERN });
        await Promise.all(tabs.map(tab => chrome.tabs.sendMessage(tab.id, message).catch(() => {})));
      } catch (e) { /* non-fatal */ }
      try { chrome.runtime.sendMessage(message, () => void chrome.runtime.lastError); } catch (e) { /* non-fatal */ }
    })();
    // Fire-and-forget — no response expected from anyone, and returning
    // true here (keeping the channel open) with nothing ever calling
    // sendResponse would just leak a pending callback.
    return false;
  }
});

// Same DP_AUTO_SEARCH flow as above, but reachable from outside the
// extension — specifically the DP Studio dashboard (a plain website, not
// a content script), which can't reach into the CRM tab on its own the
// way a content script can. Only origins listed under
// "externally_connectable" in manifest.json are able to call this at all;
// the sender.origin check below is a second, defense-in-depth guard against
// that list ever being loosened without a matching review here.
const DP_STUDIO_ORIGIN = "https://dp-dashboard-5j9.pages.dev";

chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
  if (sender.origin !== DP_STUDIO_ORIGIN) return false;
  if (message && message.type === "DP_AUTO_SEARCH") {
    handleAutoSearch(message.ref)
      .then(() => sendResponse({ ok: true }))
      .catch(err => sendResponse({ ok: false, error: String(err && err.message || err) }));
    return true;
  }
  return false;
});

// ═══════════════════════════════════════════════════════════════════════
// PHOTO ASSIGNER
// ═══════════════════════════════════════════════════════════════════════

function buildAssignerGetUrl() {
  const url = new URL(ASSIGNER_CONFIG.WEB_APP_URL);
  url.searchParams.set("token", ASSIGNER_CONFIG.TOKEN);
  return url.toString();
}

function buildDriveSearchUrl(query, workEmail) {
  const url = new URL("https://drive.google.com/drive/search");
  url.searchParams.set("q", query);
  if (workEmail) url.searchParams.set("authuser", workEmail);
  return url.toString();
}

// Per-ref request queue: ensures this tab never has two writes for the same
// listing in flight at once (e.g. an assign followed moments later by its
// automatic metadata sync). The Apps Script side also locks writes globally
// (covering multiple tabs/users), but queuing here avoids unnecessary
// contention/retries and keeps same-ref writes in the order they were made.
const refWriteQueues = new Map(); // ref -> tail promise

function runQueuedForRef(ref, task) {
  const key = ref || "";
  const prev = refWriteQueues.get(key) || Promise.resolve();
  const run = prev.then(task, task);
  const settled = run.catch(() => {}); // never let a failure break the chain
  refWriteQueues.set(key, settled);
  settled.finally(() => {
    if (refWriteQueues.get(key) === settled) refWriteQueues.delete(key);
  });
  return run;
}

function postToAssignerSheet(body, sendResponse) {
  runQueuedForRef(body.ref, () => fetchWithTimeout(ASSIGNER_CONFIG.WEB_APP_URL, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify({ ...body, token: ASSIGNER_CONFIG.TOKEN }),
    cache: "no-store",
  })
    .then(r => r.json())
    .then(data => {
      sendResponse({ ok: !data.error, data, error: data.error });
      // Push a live refresh out to every CRM tab + the side panel the
      // moment this write actually lands — see broadcastDataChanged's own
      // comment for the full rationale. Fire-and-forget: never lets a
      // broadcast hiccup affect the response already sent above.
      if (!data.error) broadcastDataChanged();
    })
    .catch(err => sendResponse({ ok: false, error: String(err) })));
}

// Every open CRM tab, told to run an immediate out-of-cycle
// refreshAssignments() pass rather than waiting for its own next poll
// tick. Shared by the manual Force Sync button (DP_FORCE_SYNC_ALL below)
// and the automatic post-write broadcast (broadcastDataChanged) so both
// paths push through the exact same mechanism.
async function pushForceRefreshToCrmTabs() {
  const tabs = await chrome.tabs.query({ url: CRM_REQUESTS_URL_PATTERN });
  await Promise.all(tabs.map(tab =>
    chrome.tabs.sendMessage(tab.id, { type: "DP_FORCE_REFRESH" }).catch(() => {})
  ));
  return tabs.length;
}

// Fires automatically after every successful assigner write (see
// postToAssignerSheet above) — assign, unassign, start, complete, reject,
// hold, downloaded, restart, all of it — so a change made in one place
// (a CRM tab, or this side panel, by this editor or any other) shows up
// everywhere else within roughly a second, rather than everyone
// independently waiting out their own next poll tick (up to 3s on a
// focused tab, up to 15s on a backgrounded one). The regular poll loops
// stay in place underneath this as the reliable fallback — this is purely
// a "don't make people wait for it" accelerant, not a replacement.
async function broadcastDataChanged() {
  try { await pushForceRefreshToCrmTabs(); } catch (e) { /* non-fatal */ }
  // chrome.tabs.sendMessage above only reaches content scripts — the side
  // panel is an extension page, not a tab, so it needs the separate
  // chrome.runtime.sendMessage broadcast instead (see the DP_FORCE_REFRESH
  // listener in sidepanel.js). No listener currently open (panel closed)
  // just means "Could not establish connection" here, which is expected
  // and harmless — reading chrome.runtime.lastError in the callback
  // prevents it surfacing as an unhandled error in the console.
  try {
    chrome.runtime.sendMessage({ type: "DP_FORCE_REFRESH" }, () => void chrome.runtime.lastError);
  } catch (e) { /* non-fatal */ }
}

// Actions that write an editor-attributed row/change to the Sheet — these
// require a name to already be selected in the popup. DP_GET_ALL (read)
// and DP_OPEN_DRIVE_SEARCH (just opens a tab) are exempt since they don't
// write anything and shouldn't be blocked.
const ASSIGNER_WRITE_TYPES = new Set([
  "DP_ASSIGN", "DP_UNASSIGN", "DP_MARK_INPROGRESS", "DP_MARK_COMPLETED",
  "DP_MARK_REJECTED", "DP_SET_ON_HOLD", "DP_SET_DOWNLOADED", "DP_SYNC_META",
  "DP_REOPEN_ON_RECATEGORIZE", "DP_SET_AUTO_ASSIGN_ELIGIBILITY",
  "DP_RESTART_REJECTED", "DP_RESTART_COMPLETED",
]);

// Defense-in-depth: the content script already blocks these actions client
// side (via identity-guard.js) before a message is ever sent, but this
// guard makes sure a write can never reach the Sheet without a name even
// if that client-side check were ever bypassed or missed.
function handleAssignerMessage(message, sendResponse) {
  if (ASSIGNER_WRITE_TYPES.has(message.type)) {
    chrome.storage.local.get(["myName"], ({ myName }) => {
      if (!myName) {
        sendResponse({ ok: false, error: "No name set. Select your name in the extension popup before using this feature." });
        return;
      }
      dispatchAssignerMessage(message, sendResponse);
    });
    return true;
  }
  return dispatchAssignerMessage(message, sendResponse);
}

function dispatchAssignerMessage(message, sendResponse) {
  if (message.type === "DP_GET_ALL") {
    // cache: "no-store" — belt-and-suspenders on top of Apps Script's own
    // uncached response headers, so this can never be served from the
    // browser's HTTP cache regardless of what those headers say. Every
    // DP_GET_ALL is a genuine live round-trip to the Sheet, always.
    fetchWithTimeout(buildAssignerGetUrl(), { cache: "no-store" })
      .then(r => r.json())
      .then(data => sendResponse({ ok: !data.error, data, error: data.error }))
      .catch(err => sendResponse({ ok: false, error: String(err) }));
    return true;
  }

  if (message.type === "DP_ASSIGN") {
    postToAssignerSheet({ action: "assign", ref: message.ref, editor: message.editor,
      title: message.title || "", actionBy: message.actionBy || "",
      crmStatus: message.crmStatus || "", isAutoAssign: !!message.isAutoAssign }, sendResponse);
    return true;
  }

  if (message.type === "DP_UNASSIGN") {
    postToAssignerSheet({ action: "unassign", ref: message.ref }, sendResponse);
    return true;
  }

  if (message.type === "DP_MARK_INPROGRESS") {
    postToAssignerSheet({ action: "markInProgress", ref: message.ref, title: message.title || "" }, sendResponse);
    return true;
  }

  if (message.type === "DP_MARK_COMPLETED") {
    postToAssignerSheet({ action: "markCompleted", ref: message.ref, editor: message.editor || "", title: message.title || "" }, sendResponse);
    return true;
  }

  if (message.type === "DP_MARK_REJECTED") {
    postToAssignerSheet({ action: "markRejected", ref: message.ref, editor: message.editor || "", title: message.title || "" }, sendResponse);
    return true;
  }

  if (message.type === "DP_SET_ON_HOLD") {
    postToAssignerSheet({ action: "setOnHold", ref: message.ref, reason: message.reason || "", title: message.title || "" }, sendResponse);
    return true;
  }

  if (message.type === "DP_SET_DOWNLOADED") {
    postToAssignerSheet({ action: "setDownloaded", ref: message.ref, downloaded: !!message.downloaded, downloadedAt: message.downloadedAt || "", title: message.title || "" }, sendResponse);
    return true;
  }

  if (message.type === "DP_SYNC_META") {
    postToAssignerSheet({ action: "syncMeta", ref: message.ref, editor: message.editor || "",
      status: message.status || "", bedrooms: message.bedrooms || "",
      crmStatus: message.crmStatus || "", title: message.title || "",
      listingRef: message.listingRef || "" }, sendResponse);
    return true;
  }

  // "Who's on duty" toggle for the round-robin auto-assigner — see the
  // matching Apps Script action for why this is separate from the rest of
  // the assignment writes (it's per-editor config, not tied to any Ref).
  if (message.type === "DP_SET_AUTO_ASSIGN_ELIGIBILITY") {
    postToAssignerSheet({ action: "setAutoAssignEligibility",
      editor: message.editor || "", eligible: !!message.eligible }, sendResponse);
    return true;
  }

  // Auto-reopens a Rejected listing when the CRM's own status has genuinely
  // moved on to a new category (e.g. a reshoot's photos are now in Upload
  // Pending) — see the matching Apps Script action for the full rationale.
  if (message.type === "DP_REOPEN_ON_RECATEGORIZE") {
    postToAssignerSheet({ action: "reopenOnCategoryChange", ref: message.ref,
      newCategory: message.newCategory || "", title: message.title || "" }, sendResponse);
    return true;
  }

  // Manual "Restart" click on a Rejected listing — see the matching Apps
  // Script action for how this differs from the automatic reopen above
  // (this one reassigns straight back to the same editor as Assigned,
  // rather than leaving it Unassigned for anyone to pick up).
  if (message.type === "DP_RESTART_REJECTED") {
    postToAssignerSheet({ action: "restartRejected", ref: message.ref,
      title: message.title || "", actionBy: message.actionBy || "" }, sendResponse);
    return true;
  }

  // Manual "Restart" click on a Completed listing — always available (not
  // gated on the "possible re-shoot" detection; that's UI-only, see the
  // content script). Same shape as the Rejected restart above: reassigns
  // straight back to the same editor as Assigned, tagged "Re-shoot" — see
  // the matching Apps Script action for the full rationale.
  if (message.type === "DP_RESTART_COMPLETED") {
    postToAssignerSheet({ action: "restartCompleted", ref: message.ref,
      title: message.title || "", actionBy: message.actionBy || "" }, sendResponse);
    return true;
  }

  if (message.type === "DP_OPEN_DRIVE_SEARCH") {
    // authuser forces Drive to open under a specific Google account (by
    // email) if that account is already signed into this Chrome profile —
    // otherwise every editor's search silently falls back to whichever
    // Google account happens to be active, which is often wrong on a
    // shared/multi-account machine. Derived from whichever name they
    // picked in the popup — same source already used for their role —
    // rather than one hardcoded email that only ever worked for one person.
    // Assumes the {firstname}@drivenproperties.com convention; see
    // WORK_EMAIL_OVERRIDES above for anyone whose real address doesn't
    // follow it.
    chrome.storage.local.get(["myName"], ({ myName }) => {
      const workEmail = myName ? buildWorkEmail(myName) : "";
      const targetUrl = buildDriveSearchUrl(message.query || "", workEmail);
      // active:false — opens the Drive search in a background tab so the
      // person's focus stays on the CRM tab instead of jumping away from it.
      chrome.tabs.create({ url: targetUrl, active: false }, () => sendResponse({ ok: true }));
    });
    return true;
  }

  // Row-click interceptor (see the "Open in new tab" toggle in the filter
  // bar) — always opens a fresh tab for the listing, rather than reusing
  // any CRM tab that's already open, and makes it the focused/active tab.
  if (message.type === "DP_OPEN_LISTING_NEW_TAB") {
    openListingInNewTab(message.url)
      .then(() => sendResponse({ ok: true }))
      .catch(err => sendResponse({ ok: false, error: String(err && err.message || err) }));
    return true;
  }

  return false;
}

// ═══════════════════════════════════════════════════════════════════════
// LISTING COPIER & LOGGER
// ═══════════════════════════════════════════════════════════════════════

async function handleLogToSheet(data) {
  // Shared identity: same "myName" the person picked for the Assigner half
  // of this extension is reused here as the Copier's editor name.
  const { myName: editorName } = await chrome.storage.local.get(["myName"]);

  if (!editorName) {
    throw new Error("No name set. Click the extension icon and select your name.");
  }

  const now = new Date();
  const dateStr = new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(now);

  const row = [
    dateStr,
    data.reqNumber || "",
    data.listingRef || "",
    data.listingLink || "",
    data.location || "",
    data.unitPlot || "",
    data.category || "",
    data.beds || "",
    data.furnishing || "",
    data.photographer || "",
    data.listType || "",
    data.status || "",
    data.receivedDate || "",
    data.rejectionReason || "",
    data.subType || "",
    data.notes || "",
    data.agentName || "",
  ];

  const response = await fetchWithTimeout(COPIER_APPS_SCRIPT_URL, {
    method:   "POST",
    headers:  { "Content-Type": "text/plain" },
    body:     JSON.stringify({ row, editorName, reShoot: data.reShoot === true }),
    redirect: "follow",
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "(no body)");
    throw new Error(`HTTP ${response.status}: ${body}`);
  }

  let result;
  try {
    result = await response.json();
  } catch {
    throw new Error("Apps Script returned non-JSON. Check the deployment URL.");
  }

  if (!result.success) {
    if (result.duplicate) {
      return { success: false, duplicate: true, error: result.error };
    }
    throw new Error(result.error || "Apps Script reported failure.");
  }

  return { success: true };
}

// ── Lifestyle / Profile logger ─────────────────────────────────────────────

async function handleLogLifestyle(data) {
  const { myName: editorName } = await chrome.storage.local.get(["myName"]);

  if (!editorName) {
    throw new Error("No name set.");
  }

  const response = await fetchWithTimeout(COPIER_APPS_SCRIPT_URL, {
    method:   "POST",
    headers:  { "Content-Type": "text/plain" },
    body:     JSON.stringify({
      action:     "logLifestyle",
      editorName: editorName,
      lifestyle:  data.lifestyle || 0,
      profile:    data.profile   || 0,
      others:     data.others    || 0,
    }),
    redirect: "follow",
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "(no body)");
    throw new Error(`HTTP ${response.status}: ${body}`);
  }

  let result;
  try {
    result = await response.json();
  } catch {
    throw new Error("Apps Script returned non-JSON.");
  }

  if (!result.success) {
    throw new Error(result.error || "Apps Script reported failure.");
  }

  return { success: true };
}

async function handleLogEmailClosed(data) {
  const { myName: editorName } = await chrome.storage.local.get(["myName"]);

  if (!editorName) {
    throw new Error("No name set.");
  }

  const subject = (data.subject || "").trim();
  if (!subject) {
    throw new Error("Subject is required.");
  }

  const response = await fetchWithTimeout(COPIER_APPS_SCRIPT_URL, {
    method:   "POST",
    headers:  { "Content-Type": "text/plain" },
    body:     JSON.stringify({
      action:     "logEmailClosed",
      editorName: editorName,
      subject:    subject,
    }),
    redirect: "follow",
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "(no body)");
    throw new Error(`HTTP ${response.status}: ${body}`);
  }

  let result;
  try {
    result = await response.json();
  } catch {
    throw new Error("Apps Script returned non-JSON.");
  }

  if (!result.success) {
    throw new Error(result.error || "Apps Script reported failure.");
  }

  return { success: true };
}
// ═══════════════════════════════════════════════════════════════════════
// DASHBOARD AUTO-SEARCH
// ═══════════════════════════════════════════════════════════════════════
// Clicking a ref in the dashboard's ref-list modal copies it (handled in
// assigner-content.js, where clipboard access has the right page focus)
// and calls here to find/open the CRM's Photo Requests search page,
// bring it to the front, and have its own copy of assigner-content.js
// (it's injected there too — same /photorequest/* match) paste the ref
// into the search box and click the search icon.

const CRM_REQUESTS_URL_PATTERN = "https://newcrm.drivenproperties.com/photorequest/*";
const CRM_REQUESTS_DEFAULT_URL = "https://newcrm.drivenproperties.com/photorequest/requests#Request";

async function handleAutoSearch(ref) {
  if (!ref) throw new Error("No reference number given.");

  const tabs = await chrome.tabs.query({ url: CRM_REQUESTS_URL_PATTERN });
  // Always target the SECOND CRM tab (by the order Chrome reports them —
  // left-to-right in the tab strip) instead of the first. Falls back to
  // the only tab available when just one is open, and to opening a brand
  // new one when none are open at all.
  let tab = tabs.length > 1 ? tabs[1] : tabs[0];

  if (tab) {
    await chrome.tabs.update(tab.id, { active: true });
    if (tab.windowId != null) {
      try { await chrome.windows.update(tab.windowId, { focused: true }); } catch {}
    }
    await sendFillMessageWithRetry(tab.id, ref);
    return;
  }

  // No matching tab open anywhere — open one and wait for it to finish
  // loading before we try to talk to its content script.
  const newTab = await chrome.tabs.create({ url: CRM_REQUESTS_DEFAULT_URL, active: true });
  await waitForTabComplete(newTab.id);
  await sendFillMessageWithRetry(newTab.id, ref);
}

// Row-click "Open in new tab" feature — the content script lets the CRM's
// own click handling assign the listing's unique URL (a hash suffix like
// #Request#vZ13PGMbXk that only exists once the drawer has actually
// opened), then hands us that exact URL here. So unlike handleAutoSearch
// above, there's no ref to search for — we just duplicate the URL as-is
// into a brand-new tab (never reusing an existing CRM tab, since the point
// is to open the listing somewhere new) and make it the focused tab.
async function openListingInNewTab(url) {
  if (!url) throw new Error("No listing URL to open.");
  if (!/^https:\/\/newcrm\.drivenproperties\.com\//.test(url)) {
    throw new Error("Refusing to open a non-CRM URL.");
  }

  const newTab = await chrome.tabs.create({ url, active: true });
  if (newTab.windowId != null) {
    try { await chrome.windows.update(newTab.windowId, { focused: true }); } catch {}
  }
}

function waitForTabComplete(tabId) {
  return new Promise(resolve => {
    function listener(id, info) {
      if (id === tabId && info.status === "complete") {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

// The tab may report "complete" before its Vue app has hydrated and this
// extension's content script has attached its onMessage listener, so
// retry a few times (with a short pause) before giving up.
async function sendFillMessageWithRetry(tabId, ref, attempts = 8) {
  for (let i = 0; i < attempts; i++) {
    try {
      const resp = await chrome.tabs.sendMessage(tabId, { type: "DP_FILL_SEARCH", ref });
      if (resp && resp.ok) return;
    } catch {
      // "Receiving end does not exist" while the page is still settling —
      // fall through and retry.
    }
    await new Promise(r => setTimeout(r, 400));
  }
  throw new Error("Could not reach the search box on the CRM tab in time.");
}

// ═══════════════════════════════════════════════════════════════════════
// AUTO "ALL" FILTER CLICK
// ═══════════════════════════════════════════════════════════════════════
// The side panel's "Auto-Refresh" toggle + interval slider (sidepanel.js)
// write straight to chrome.storage.local — no message needed to turn this
// on/off, we just react to the storage change here. While enabled, once
// every N minutes (1–60, whatever the slider is set to) this pings the
// first open CRM Photo Requests tab IN THAT SAME WINDOW and has
// auto-all-click-content.js click that page's own "All" filter button,
// which forces the board to reload its data. Runs from the background so
// it keeps going even if the side panel itself gets closed — only
// flipping the toggle off (or closing the window) stops it.
//
// Scoped per-window, not globally, per the "independent automation across
// Chrome windows/macOS Spaces" requirement: each window's side panel
// writes to its OWN storage key (dpAutoAllClick:<windowId>, set once that
// panel knows its window's id — see sidepanel.js) and gets its OWN named
// chrome.alarms entry, so a window with this off never has its board
// force-refreshed by a schedule that actually belongs to a completely
// different window, and turning it off in one window can't touch any
// other window's alarm — they're independent alarms with independent
// names, not shared state.
const AUTO_ALL_CLICK_STORAGE_PREFIX = "dpAutoAllClick:"; // + windowId → { enabled, intervalMinutes }
const AUTO_ALL_CLICK_ALARM_PREFIX   = "dpAutoAllClick:"; // + windowId — same prefix, kept as a separate constant since they're conceptually different namespaces (storage keys vs. alarm names) that just happen to share a spelling
// Not read anywhere in background.js beyond the cleanup below — this is
// assigner-content.js's/sidepanel.js's per-window Auto Assign storage key
// prefix, mirrored here only so chrome.windows.onRemoved can clean up
// after a closed window without needing to hardcode the string twice.
const AUTO_ASSIGN_STORAGE_PREFIX = "dpAutoAssignEnabled:"; // + windowId → true/false

async function syncAutoAllClickAlarm(windowId) {
  if (windowId == null) return;
  const key = AUTO_ALL_CLICK_STORAGE_PREFIX + windowId;
  const alarmName = AUTO_ALL_CLICK_ALARM_PREFIX + windowId;
  const result = await chrome.storage.local.get([key]);
  const settings = result[key];
  const enabled  = !!(settings && settings.enabled);
  const minutes  = Math.min(60, Math.max(1, Number(settings && settings.intervalMinutes) || 5));

  if (enabled) {
    // Re-creating with the same name just resets the existing alarm to the
    // (possibly new) interval rather than duplicating it — safe to call
    // this on every service worker wake, same pattern as the assignment
    // notification poller above.
    chrome.alarms.create(alarmName, { periodInMinutes: minutes });
  } else {
    chrome.alarms.clear(alarmName);
  }
}

// Re-establishes every window's own alarm on a fresh service worker wake
// (browser/extension restart) — chrome.alarms don't survive that, but the
// settings each window last saved in chrome.storage.local do, so this
// scans for every dpAutoAllClick:<windowId> key that exists and re-arms
// each one independently.
async function resyncAllAutoAllClickAlarms() {
  const all = await chrome.storage.local.get(null);
  Object.keys(all)
    .filter(k => k.startsWith(AUTO_ALL_CLICK_STORAGE_PREFIX))
    .forEach(k => syncAutoAllClickAlarm(k.slice(AUTO_ALL_CLICK_STORAGE_PREFIX.length)));
}

// Covers both "toggled from a side panel just now" (storage.onChanged
// wakes the service worker on its own) and "browser/extension just
// restarted" (this top-level call runs every time the worker wakes fresh).
resyncAllAutoAllClickAlarms();
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  Object.keys(changes)
    .filter(k => k.startsWith(AUTO_ALL_CLICK_STORAGE_PREFIX))
    .forEach(k => syncAutoAllClickAlarm(k.slice(AUTO_ALL_CLICK_STORAGE_PREFIX.length)));
});

chrome.alarms.onAlarm.addListener(alarm => {
  if (!alarm.name.startsWith(AUTO_ALL_CLICK_ALARM_PREFIX)) return;
  clickAllFilterOnCrmTabs(alarm.name.slice(AUTO_ALL_CLICK_ALARM_PREFIX.length));
});

async function clickAllFilterOnCrmTabs(windowId) {
  const tabs = await chrome.tabs.query({ url: CRM_REQUESTS_URL_PATTERN, windowId: Number(windowId) });
  // Only the FIRST CRM tab in THIS window (by the order Chrome reports
  // them — left-to-right in that window's tab strip) gets auto-clicked,
  // not every open one — deliberately the opposite of handleAutoSearch's
  // "always the second tab" above, so between the two features every CRM
  // tab someone actually works from stays untouched by this.
  const tab = tabs[0];
  if (!tab) return;

  try {
    await chrome.tabs.sendMessage(tab.id, { type: "DP_CLICK_ALL_FILTER" });
  } catch {
    // No content script on this tab yet (still loading) or it's not
    // currently on the requests list view — just skip this tick.
  }
}

// A window closing should stop and clean up after itself, not leave an
// orphaned alarm ticking forever in the background or stale per-window
// settings sitting in storage indefinitely — this is also what makes
// "the automation naturally stops once its dedicated window is closed"
// true without needing any special-cased shutdown logic anywhere else.
chrome.windows.onRemoved.addListener(windowId => {
  chrome.alarms.clear(AUTO_ALL_CLICK_ALARM_PREFIX + windowId);
  chrome.storage.local.remove([
    AUTO_ALL_CLICK_STORAGE_PREFIX + windowId,
    AUTO_ASSIGN_STORAGE_PREFIX + windowId,
  ]);
});

