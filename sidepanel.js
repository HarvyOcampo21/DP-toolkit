"use strict";

// Single source of truth for who is senior vs junior — shared with
// background.js's default and used to gate Assigner permissions in
// assigner-content.js. Add/move names here as the team changes.
const NAME_ROLES = {
  Harvy:   "senior",
  Mark:    "senior",
  Sudheep: "senior",
};
function roleForName(name) {
  return NAME_ROLES[name] || "junior"; // unknown names default to the safer role
}

// ── Category filter tabs ────────────────────────────────────────────────
// "Stock Photos For QC" and "Photos For QC" both live under one combined
// "QC" tab since, from an assignment-triage standpoint, they're the same
// kind of work — the distinction only matters once you're inside the card.
const CATEGORY_FILTERS = [
  { id: "all",     label: "All",              icon: "icons/filters/all.png",     match: null },
  { id: "qc",      label: "QC",               icon: "icons/filters/qc.png",
    match: s => s === "Photos For QC" || s === "Stock Photos For QC" },
  { id: "offplan", label: "Offplan Pending",  icon: "icons/filters/offplan.png", match: s => s === "Offplan Pending" },
  { id: "upload",  label: "Upload Pending",   icon: "icons/filters/upload.png",  match: s => s === "Upload Pending" },
];
const DP_CATEGORY_FILTER_KEY = "dpCategoryFilter";
let activeCategoryFilter = "all";
let currentUserName = null; // set once in showMain — lets tab clicks re-render without re-threading `name` everywhere
let currentUserRole = null; // "senior" | "junior" — gates the Settings drawer's Auto-assign/On duty rows

// ── Elements ────────────────────────────────────────────────────────────
const setupDiv      = document.getElementById("setup");
const identityBar    = document.getElementById("identityBar");
const nameSelect     = document.getElementById("nameSelect");
const saveBtn        = document.getElementById("saveBtn");
const whoText        = document.getElementById("whoText");
const changeBtn      = document.getElementById("changeNameBtn");
const assignSection  = document.getElementById("assignSection");

const listContainer  = document.getElementById("listContainer");
const totalBadge     = document.getElementById("totalBadge");
const categoryTabsEl = document.getElementById("dpCategoryTabs");
const statCompletedEl = document.getElementById("dpStatCompleted");
const statRejectedEl  = document.getElementById("dpStatRejected");
const statTotalEl     = document.getElementById("dpStatTotal");

const autoAllToggle         = document.getElementById("dpAutoAllToggle");
const autoAllIntervalWrap   = document.getElementById("dpAutoAllIntervalWrap");
const autoAllIntervalInput  = document.getElementById("dpAutoAllInterval");
const autoAllIntervalValueEl = document.getElementById("dpAutoAllIntervalValue");
const autoAllCountdownEl    = document.getElementById("dpAutoAllCountdown");

// ── Identity ────────────────────────────────────────────────────────────
function showSetup() {
  setupDiv.style.display     = "block";
  identityBar.style.display  = "none";
  assignSection.style.display = "none";
  stopLivePolling();
}

function showMain(name, role) {
  setupDiv.style.display      = "none";
  identityBar.style.display   = "flex";
  assignSection.style.display = "flex";

  currentUserName = name;
  currentUserRole = role;
  whoText.textContent = `Hi, ${name}!`;

  const autoAssignSection = document.getElementById("dpAutoAssignSection");
  if (autoAssignSection) autoAssignSection.style.display = role === "senior" ? "block" : "none";

  renderAssignmentsList(name);
  checkConnection();
  startLivePolling(name);
}

// ── Live polling ──────────────────────────────────────────────────────────
// Completing (or rejecting/reassigning) a listing normally happens over on
// the CRM tab, not from this panel — so without this, a just-completed
// listing would keep sitting in "Active assignments" here until someone
// happened to reopen the panel or hit Force Sync. Polling in the background
// means it drops off on its own within a few seconds, same spirit as the
// CRM board's own ~3s active refresh (see v34 in the changelog). Paused
// while the panel is hidden so it doesn't burn requests for no one to see,
// and it re-syncs immediately the moment it's looked at again.
const DP_POLL_INTERVAL_MS = 5000;
let dpPollTimer = null;

function startLivePolling(name) {
  stopLivePolling();
  dpPollTimer = setInterval(() => {
    if (document.visibilityState === "visible") refreshFromServer(name);
  }, DP_POLL_INTERVAL_MS);
}

function stopLivePolling() {
  if (dpPollTimer) { clearInterval(dpPollTimer); dpPollTimer = null; }
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;
  chrome.storage.local.get(["myName"], ({ myName }) => {
    if (myName) refreshFromServer(myName);
  });
});

saveBtn.addEventListener("click", () => {
  const name = nameSelect.value;
  if (!name) { nameSelect.style.borderColor = "#e6941a"; return; }
  const role = roleForName(name);
  chrome.storage.local.set(
    { myName: name, role, dpNotifyBaselineDone: false, dpSeenAssignedRefs: [] },
    () => showMain(name, role)
  );
});

changeBtn.addEventListener("click", showSetup);

chrome.storage.local.get(["myName", "role", DP_CATEGORY_FILTER_KEY], result => {
  if (CATEGORY_FILTERS.some(f => f.id === result[DP_CATEGORY_FILTER_KEY])) {
    activeCategoryFilter = result[DP_CATEGORY_FILTER_KEY];
  }

  const name = result && result.myName;
  if (!name) { showSetup(); return; }

  // Recompute role from the roster every time the panel opens, so a
  // promotion/demotion just needs an edit to NAME_ROLES above — no
  // reinstall or manual storage reset needed.
  const role = roleForName(name);
  if (role !== result.role) chrome.storage.local.set({ role });
  nameSelect.value = name;
  showMain(name, role);
});

// ═══════════════════════════════════════════════════════════════════════
// ASSIGNMENTS
// ═══════════════════════════════════════════════════════════════════════

// Longest/most-specific prefixes first — though since every prefix here
// starts with a different leading character set (D vs C vs bare R/S),
// order doesn't actually change the result; kept this way for readability.
const RENTAL_PREFIXES = ["DPA-R-", "DP-R-", "CBB-R-", "R-"];
const SALES_PREFIXES  = ["DPA-S-", "DP-S-", "CBB-S-", "S-"];

function listingType(listingRef) {
  if (!listingRef) return null;
  const ref = listingRef.toUpperCase();
  if (RENTAL_PREFIXES.some(p => ref.startsWith(p))) return "rental";
  if (SALES_PREFIXES.some(p => ref.startsWith(p))) return "sales";
  return null;
}

// crmStatus is already normalized by assigner-content.js (CRM_STATUS_ALIASES)
// to one of CATEGORY_OPTIONS before it's saved — "Re-shoot" is a 5th,
// internal-only value from that same set and deliberately gets no badge here.
const CATEGORY_CLASS = {
  "Photos For QC":       "cat-photos-qc",
  "Stock Photos For QC": "cat-stock-photos-qc",
  "Offplan Pending":     "cat-offplan-pending",
  "Upload Pending":      "cat-upload-pending",
};

// Same border/tint values as ROW_STATUS_COLORS in assigner-content.js, so a
// card's color always matches how that same listing looks on the CRM page.
// Keep these two in sync if the palette ever changes over there.
const STATUS_COLORS = {
  assigned:   { border: "#e6941a", tint: "rgba(230, 148, 26, 0.10)" },
  inprogress: { border: "#3b82f6", tint: "rgba(59, 130, 246, 0.10)" },
  onhold:     { border: "#b39ddb", tint: "rgba(179, 157, 219, 0.10)" },
  rejected:   { border: "#ef5350", tint: "rgba(239, 83, 80, 0.10)" },
  completed:  { border: "#00d1b2", tint: "rgba(0, 209, 178, 0.10)" },
};
function rowStatusKey(status) {
  return status === "Assigned"    ? "assigned"   :
         status === "In Progress" ? "inprogress" :
         status === "On Hold"     ? "onhold"     :
         status === "Rejected"    ? "rejected"   :
         status === "Completed"   ? "completed"  : "";
}

// On Hold is still an active assignment (just paused) — only Unassigned/
// Completed/Rejected fall out of "active assignments" here. In Progress
// belongs here too (a listing someone just Started is very much still
// active) — leaving it out meant tapping Start made a card disappear
// from its own owner's list mid-shoot.
const ACTIVE_STATUSES = ["Assigned", "In Progress", "On Hold"];

// currentAssignments holds the exact objects rendered on screen right now
// (keyed by ref via each card's dataset), so an action can mutate the
// SAME object the card was built from and re-render just that one card —
// instant feedback, no round trip to the server needed to see the change.
let currentAssignments = [];

// ── Today's activity stats (Completed / Rejected / Total) ────────────────
// Read straight from each of the CURRENT USER's assignments' own history
// log (the same a.history used by the per-card timeline) — count any
// "completed"/"rejected" event whose timestamp falls on today's calendar
// date. Nothing to reset at midnight: since it's always computed fresh off
// real timestamps rather than an incrementing counter, it naturally only
// ever reflects "today" the moment the clock rolls over.
let currentTodayStats = { completed: 0, rejected: 0, total: 0 };

function isToday(iso) {
  if (!iso) return false;
  const d = new Date(iso);
  if (isNaN(d)) return false;
  const now = new Date();
  return d.getFullYear() === now.getFullYear() &&
         d.getMonth() === now.getMonth() &&
         d.getDate() === now.getDate();
}

function computeTodayStats(fullAssignments, name) {
  let completed = 0, rejected = 0;
  fullAssignments.forEach(a => {
    if (a.editor !== name) return;
    const historyLog = Array.isArray(a.history) ? a.history : [];
    historyLog.forEach(e => {
      if (!e || !e.ts) return;
      if (e.type === "completed" && isToday(e.ts)) completed++;
      if (e.type === "rejected"  && isToday(e.ts)) rejected++;
    });
  });
  return { completed, rejected, total: completed + rejected };
}

function renderTodayStats() {
  if (!statCompletedEl || !statRejectedEl || !statTotalEl) return;
  statCompletedEl.textContent = String(currentTodayStats.completed);
  statRejectedEl.textContent  = String(currentTodayStats.rejected);
  statTotalEl.textContent     = String(currentTodayStats.total);
}

// ── Round-robin auto-assign (Configuration, in the Settings drawer) ─────
// Mirrors the exact same recommendation algorithm assigner-content.js runs
// on the CRM page (same EDITORS list, same "today, in eligible-editor
// order, break ties by whoever was picked last" logic) — but the panel
// only ever DISPLAYS "Next up" and lets a senior toggle On duty /
// Auto-assign here; it never assigns anything itself. The actual engine
// that watches for fresh Unassigned listings and calls assign() still has
// to live in assigner-content.js, since that requires the CRM page's own
// DOM. autoAssignConfig and allAssignmentsForAutoAssign are refreshed
// alongside every regular poll in refreshFromServer.
const EDITORS = ["Harvy", "Jabir", "Mark", "Sudheep"];
let autoAssignConfig = {};
let allAssignmentsForAutoAssign = [];

function getAutoAssignRecommendation() {
  const counts = {};
  EDITORS.forEach(e => { counts[e] = 0; });
  const eligibleEditors = EDITORS.filter(e => autoAssignConfig[e] !== false);
  const todayStr = new Date().toDateString();
  let lastPicked = null, lastPickedAt = -Infinity;

  allAssignmentsForAutoAssign.forEach(entry => {
    if (!entry || !entry.editor || !EDITORS.includes(entry.editor)) return;
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

function renderNextUpLine() {
  const el = document.getElementById("dpNextUpLine");
  if (!el) return;
  const { next, counts } = getAutoAssignRecommendation();
  el.textContent = next ? `\u2192 Next up: ${next} (${counts[next] || 0} today)` : "\u2192 No one eligible \u2014 check On duty";
}

// Rebuilds the On duty checkbox list from the current autoAssignConfig.
// Cheap enough to fully rebuild (only 4 editors) rather than diff.
function renderOnDutyList() {
  const wrap = document.getElementById("dpOnDutyList");
  if (!wrap) return;
  wrap.innerHTML = "";

  EDITORS.forEach(name => {
    const row = document.createElement("label");
    row.className = "dp-onduty-row";

    const nameWrap = document.createElement("span");
    nameWrap.className = "dp-onduty-name-wrap";
    nameWrap.textContent = name;

    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = autoAssignConfig[name] !== false;
    cb.addEventListener("change", () => {
      const eligible = cb.checked;
      // Optimistic, same pattern as everywhere else in this file — flips
      // immediately, reverts itself if the server comes back with
      // anything other than success.
      const previous = autoAssignConfig[name] !== false;
      autoAssignConfig = { ...autoAssignConfig, [name]: eligible };
      renderNextUpLine();
      chrome.runtime.sendMessage({ type: "DP_SET_AUTO_ASSIGN_ELIGIBILITY", editor: name, eligible }, resp => {
        if (!(resp && resp.ok)) {
          cb.checked = previous;
          autoAssignConfig = { ...autoAssignConfig, [name]: previous };
          renderNextUpLine();
          showToast(`Could not update ${name}'s On duty status.`);
        }
      });
    });

    row.appendChild(nameWrap);
    row.appendChild(cb);
    wrap.appendChild(row);
  });
}

function renderAutoAssignSettings() {
  renderNextUpLine();
  renderOnDutyList();
}

// ── Local snapshot cache ─────────────────────────────────────────────────
// Same idea as assigner-content.js's dpAssignSnapshot on the CRM page: the
// panel shouldn't go blank/"Loading…" every time it's opened just because
// the network round trip hasn't come back yet. Whatever was last rendered
// (including the panel's own optimistic writes — see refreshCard below) is
// written to storage as it happens, so the very next open can paint
// instantly from that, then quietly refresh from the server in the
// background and reconcile once the real data lands.
const DP_SNAPSHOT_KEY = "dpSidepanelSnapshot";

function saveSnapshot(name) {
  try {
    chrome.storage.local.set({
      [DP_SNAPSHOT_KEY]: JSON.stringify({
        name, assignments: currentAssignments, todayStats: currentTodayStats, savedAt: Date.now(),
      }),
    });
  } catch (e) { /* storage full or unavailable — snapshot is a nice-to-have, not required */ }
}

function loadSnapshot(name, cb) {
  chrome.storage.local.get([DP_SNAPSHOT_KEY], result => {
    const raw = result && result[DP_SNAPSHOT_KEY];
    if (!raw) { cb(null); return; }
    try {
      const snap = JSON.parse(raw);
      // Only trust a snapshot saved for THIS name and shaped the way we
      // expect — a stale/foreign/malformed snapshot is treated as none.
      if (snap && snap.name === name && Array.isArray(snap.assignments)) cb(snap);
      else cb(null);
    } catch (e) { cb(null); }
  });
}

function findCardEl(ref) {
  return Array.from(listContainer.children).find(el => el.dataset && el.dataset.dpRef === ref);
}

// Assignments matching the currently selected tab. "All" (match: null)
// always returns the full list untouched.
function visibleAssignments() {
  const filter = CATEGORY_FILTERS.find(f => f.id === activeCategoryFilter) || CATEGORY_FILTERS[0];
  return filter.match ? currentAssignments.filter(a => filter.match(a.crmStatus)) : currentAssignments;
}

function renderTotalBadge() {
  if (!totalBadge) return;
  const n = visibleAssignments().length;
  totalBadge.innerHTML = n ? `Total: <span>${n}</span>` : "";
}

// Rebuilds the tab strip itself — icon + a small count badge per tab, and
// an is-active class on whichever one matches activeCategoryFilter. Cheap
// enough to just fully rebuild every time the list changes rather than
// diffing, since there are only ever 4 of these.
function renderCategoryTabs() {
  if (!categoryTabsEl) return;
  categoryTabsEl.innerHTML = "";

  CATEGORY_FILTERS.forEach(f => {
    const count = f.match ? currentAssignments.filter(a => f.match(a.crmStatus)).length : currentAssignments.length;

    const tab = document.createElement("div");
    tab.className = "dp-tab" + (activeCategoryFilter === f.id ? " is-active" : "");
    tab.title = `${f.label}${count ? ` (${count})` : ""}`;
    tab.setAttribute("role", "button");
    tab.setAttribute("aria-label", f.label);
    tab.setAttribute("aria-pressed", activeCategoryFilter === f.id ? "true" : "false");

    const icon = document.createElement("span");
    icon.className = "dp-tab-icon";
    icon.style.webkitMaskImage = `url("${f.icon}")`;
    icon.style.maskImage = `url("${f.icon}")`;
    tab.appendChild(icon);

    if (count > 0) {
      const badge = document.createElement("span");
      badge.className = "dp-tab-count";
      badge.textContent = count > 99 ? "99+" : String(count);
      tab.appendChild(badge);
    }

    tab.addEventListener("click", () => {
      if (activeCategoryFilter === f.id) return;
      activeCategoryFilter = f.id;
      chrome.storage.local.set({ [DP_CATEGORY_FILTER_KEY]: f.id });
      renderList(currentUserName);
    });

    categoryTabsEl.appendChild(tab);
  });
}

// Full rebuild of the list from whatever's currently in currentAssignments
// — used for the initial paint (from cache or from a fresh fetch) and
// after every background refresh. Individual actions don't go through
// this; they patch just their own card via refreshCard for instant,
// flicker-free feedback.
function renderList(name) {
  renderCategoryTabs();
  renderTodayStats();

  const visible = visibleAssignments();
  if (currentAssignments.length === 0) {
    listContainer.innerHTML = '<div class="empty-state">No active assignments — all clear!</div>';
  } else if (visible.length === 0) {
    listContainer.innerHTML = '<div class="empty-state">Nothing in this category right now.</div>';
  } else {
    listContainer.innerHTML = "";
    visible.forEach(a => listContainer.appendChild(buildAssignCard(a, name)));
  }
  renderTotalBadge();
}

// opts.skipCache forces straight past the local snapshot to a fresh
// network fetch (with the normal "Loading…" state) — used by Force Sync,
// where the whole point is bypassing whatever's cached.
function renderAssignmentsList(name, opts) {
  const skipCache = !!(opts && opts.skipCache);
  if (skipCache) {
    listContainer.innerHTML = '<div class="loading">Loading…</div>';
    if (totalBadge) totalBadge.innerHTML = "";
    refreshFromServer(name);
    return;
  }

  loadSnapshot(name, snap => {
    if (snap) {
      currentAssignments = snap.assignments;
      // Only trust cached stats if they were saved today — otherwise
      // they're yesterday's numbers and would flash before the real
      // fetch below corrects them a moment later.
      currentTodayStats = (snap.todayStats && isToday(new Date(snap.savedAt).toISOString()))
        ? snap.todayStats
        : { completed: 0, rejected: 0, total: 0 };
      renderList(name);
    } else {
      listContainer.innerHTML = '<div class="loading">Loading…</div>';
      if (totalBadge) totalBadge.innerHTML = "";
    }
    // Always follow up with a real fetch, whether or not we had a cached
    // snapshot to paint first — the cache is only ever a placeholder for
    // the instant the panel opens, never the final word.
    refreshFromServer(name);
  });
}

function refreshFromServer(name) {
  chrome.runtime.sendMessage({ type: "DP_GET_ALL" }, resp => {
    if (!resp || !resp.ok || !resp.data || !Array.isArray(resp.data.assignments)) {
      // Nothing to show yet at all (first-ever load, no snapshot) — show
      // the error state. Otherwise leave the cached cards up rather than
      // wiping a perfectly good (if slightly stale) view over one failed
      // refresh, and just let the person know.
      if (currentAssignments.length === 0) {
        listContainer.innerHTML = '<div class="empty-state">Could not load listings.</div>';
      } else {
        showToast("Could not refresh — showing last known data.");
      }
      return;
    }

    currentAssignments = resp.data.assignments.filter(a =>
      a.editor === name && ACTIVE_STATUSES.includes(a.status)
    );
    currentTodayStats = computeTodayStats(resp.data.assignments, name);
    allAssignmentsForAutoAssign = resp.data.assignments;
    if (resp.data.autoAssignConfig && typeof resp.data.autoAssignConfig === "object") {
      autoAssignConfig = resp.data.autoAssignConfig;
    }
    renderList(name);
    renderAutoAssignSettings();
    saveSnapshot(name);
  });
}

// Re-renders a single assignment's card in place after its status was
// mutated locally — or drops it out of the list if that status no longer
// counts as "active". Called both right after the optimistic update and
// again if the server write turns out to have failed (to roll it back).
// Either way, the snapshot is re-saved so a quick close/reopen of the
// panel reflects exactly what's on screen, not a moment before it.
function refreshCard(a, name) {
  const stillActive   = ACTIVE_STATUSES.includes(a.status);
  const oldCard       = findCardEl(a.ref);
  const filter        = CATEGORY_FILTERS.find(f => f.id === activeCategoryFilter) || CATEGORY_FILTERS[0];
  const matchesFilter = !filter.match || filter.match(a.crmStatus);

  if (!stillActive) {
    currentAssignments = currentAssignments.filter(x => x !== a);
    if (oldCard) oldCard.remove();
  } else if (!matchesFilter) {
    // Still an active assignment, just not part of the currently selected
    // tab — pull it off screen without touching currentAssignments.
    if (oldCard) oldCard.remove();
  } else {
    const newCard = buildAssignCard(a, name);
    if (oldCard) oldCard.replaceWith(newCard);
    else listContainer.appendChild(newCard);
  }

  if (visibleAssignments().length === 0) {
    listContainer.innerHTML = currentAssignments.length === 0
      ? '<div class="empty-state">No active assignments — all clear!</div>'
      : '<div class="empty-state">Nothing in this category right now.</div>';
  }

  renderCategoryTabs();
  renderTotalBadge();
  saveSnapshot(name);
}

function buildAssignCard(a, name) {
  const card = document.createElement("div");
  card.className = "assign-card";
  card.dataset.dpRef = a.ref || "";

  const statusKey = rowStatusKey(a.status);
  const colors = STATUS_COLORS[statusKey];
  if (colors) {
    card.style.setProperty("background-color", colors.tint);
    card.style.setProperty("border-color", colors.border);
  }

  const top = document.createElement("div");
  top.className = "ac-top";

  const listingRefEl = document.createElement("span");
  listingRefEl.className = "ac-listing-ref";
  listingRefEl.textContent = a.listingRef || "(no listing ref)";
  if (a.listingRef) {
    listingRefEl.classList.add("ac-ref-clickable");
    listingRefEl.title = `Search ${a.listingRef} on the CRM tab`;
    listingRefEl.addEventListener("click", () => dpAutoSearch(a.listingRef));
  }
  top.appendChild(listingRefEl);

  // ── Top-right cluster: status beside the Rental/Sales pill ─────────────
  const topRight = document.createElement("div");
  topRight.className = "ac-top-right";

  if (a.status) {
    const status = document.createElement("span");
    status.className = "ac-status";
    status.textContent = a.status;
    if (colors) status.style.color = colors.border;
    topRight.appendChild(status);
  }

  const type = listingType(a.listingRef);
  if (type) {
    const tag = document.createElement("span");
    tag.className = "ac-type-tag " + (type === "rental" ? "ac-type-rental" : "ac-type-sales");
    tag.textContent = type === "rental" ? "RENTAL" : "SALES";
    topRight.appendChild(tag);
  }

  if (topRight.childNodes.length) top.appendChild(topRight);
  card.appendChild(top);

  const reqRef = document.createElement("div");
  reqRef.className = "ac-req-ref";
  reqRef.textContent = a.ref || "";
  if (a.ref) {
    reqRef.classList.add("ac-ref-clickable");
    reqRef.title = `Search ${a.ref} on the CRM tab`;
    reqRef.addEventListener("click", () => dpAutoSearch(a.ref));
  }
  card.appendChild(reqRef);

  // ── Bottom row: category pill beside Start / Hold / View Reason ────────
  // Rejected listings never appear in this list (ACTIVE_STATUSES excludes
  // "Rejected"), so there's no Restart button here — Restart only makes
  // sense from the CRM page's full board where Rejected rows are visible.
  const bottomRow = document.createElement("div");
  bottomRow.className = "ac-bottom-row";

  const categoryClass = CATEGORY_CLASS[a.crmStatus];
  if (categoryClass) {
    const cat = document.createElement("span");
    cat.className = "ac-category " + categoryClass;
    cat.textContent = a.crmStatus;
    bottomRow.appendChild(cat);
  }

  const actionsRow = document.createElement("div");
  actionsRow.className = "ac-actions-row";

  const isOnHold = a.status === "On Hold";
  const isActive = a.status === "Assigned" || a.status === "In Progress" || a.status === "On Hold";

  if (a.status === "Assigned" || a.status === "On Hold") {
    actionsRow.appendChild(mkActionBtn("Start", "ac-start-btn", () => {
      applyOptimisticUpdate(a, name, { status: "In Progress" },
        () => dpSendAction("DP_MARK_INPROGRESS", { ref: a.ref, title: a.title }));
    }));
  }

  if (isActive) {
    actionsRow.appendChild(mkActionBtn("Hold", "ac-hold-btn", () => {
      showOnHoldModal("", "edit", reason => {
        applyOptimisticUpdate(a, name, { status: "On Hold", onHoldReason: reason },
          () => dpSendAction("DP_SET_ON_HOLD", { ref: a.ref, reason, title: a.title }));
      });
    }, "Put on hold with reason"));
  }

  if (isOnHold) {
    actionsRow.appendChild(mkActionBtn("View Reason", "ac-reason-btn", () => {
      showOnHoldModal(a.onHoldReason || "", "edit", reason => {
        applyOptimisticUpdate(a, name, { onHoldReason: reason },
          () => dpSendAction("DP_SET_ON_HOLD", { ref: a.ref, reason, title: a.title }));
      });
    }, "See why this listing is on hold"));
  }

  if (actionsRow.childNodes.length) bottomRow.appendChild(actionsRow);
  if (bottomRow.childNodes.length) card.appendChild(bottomRow);

  // ── Icon row: Drive search / History (sliding) / Copy ref / Downloaded ─
  const iconRow = document.createElement("div");
  iconRow.className = "ac-icon-row";

  if (a.listingRef) {
    const driveBtn = mkIconBtn(ICON_DRIVE, `Find ${a.listingRef} in Google Drive`);
    driveBtn.addEventListener("click", () => {
      chrome.runtime.sendMessage({ type: "DP_OPEN_DRIVE_SEARCH", query: a.listingRef }, resp => {
        if (!(resp && resp.ok)) showToast("Could not open Drive search.");
      });
    });
    iconRow.appendChild(driveBtn);
  }

  const historyBtn = mkIconBtn(ICON_HISTORY, "View time history for this listing");
  const historyPanel = document.createElement("div");
  historyPanel.className = "ac-history-panel";
  let historyBuilt = false, historyOpen = false;
  historyBtn.addEventListener("click", () => {
    if (!historyBuilt) {
      buildHistoryTimeline(historyPanel, a);
      historyBuilt = true;
    }
    historyOpen = !historyOpen;
    historyBtn.classList.toggle("is-active", historyOpen);
    // Slide open/closed by animating max-height off the panel's own
    // measured scrollHeight — re-measured on every open so a panel that
    // was built with stale/loading content still ends up the right size.
    if (historyOpen) {
      historyPanel.style.maxHeight = historyPanel.scrollHeight + "px";
    } else {
      historyPanel.style.maxHeight = "0px";
    }
  });
  iconRow.appendChild(historyBtn);

  const copyBtn = mkIconBtn(ICON_COPY, "Copy reference number");
  copyBtn.addEventListener("click", () => {
    if (!a.ref) return;
    navigator.clipboard.writeText(a.ref).then(() => {
      copyBtn.classList.add("is-copied");
      showToast(`Copied to clipboard: ${a.ref}`);
      setTimeout(() => copyBtn.classList.remove("is-copied"), 1200);
    }).catch(() => showToast("Could not copy to clipboard."));
  });
  iconRow.appendChild(copyBtn);

  // ── Downloaded checkbox — sits right beside the copy-ref button ────────
  const downloadedLabel = document.createElement("label");
  downloadedLabel.className = "ac-downloaded-wrap";
  downloadedLabel.title = "Mark as downloaded from Drive";
  const downloadedCheckbox = document.createElement("input");
  downloadedCheckbox.type = "checkbox";
  downloadedCheckbox.checked = !!a.downloaded;
  downloadedCheckbox.addEventListener("change", () => {
    const val = downloadedCheckbox.checked;
    const downloadedAt = val ? new Date().toISOString() : "";
    a.downloaded = val;
    saveSnapshot(name);
    dpSendAction("DP_SET_DOWNLOADED", { ref: a.ref, downloaded: val, downloadedAt, title: a.title }, () => {
      a.downloaded = !val;
      downloadedCheckbox.checked = !val;
      saveSnapshot(name);
    });
  });
  const downloadedText = document.createElement("span");
  downloadedText.textContent = "Downloaded";
  downloadedLabel.appendChild(downloadedCheckbox);
  downloadedLabel.appendChild(downloadedText);
  iconRow.appendChild(downloadedLabel);

  card.appendChild(iconRow);
  card.appendChild(historyPanel);

  return card;
}

// ── Small DOM builders for action/icon buttons ──────────────────────────
function mkActionBtn(text, className, onClick, title) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "ac-btn " + className;
  btn.textContent = text;
  if (title) btn.title = title;
  btn.addEventListener("click", e => { e.stopPropagation(); onClick(); });
  return btn;
}

function mkIconBtn(svg, title) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "ac-icon-btn";
  btn.title = title;
  btn.innerHTML = svg;
  btn.addEventListener("click", e => e.stopPropagation());
  return btn;
}

const ICON_DRIVE = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2z"></path><circle cx="11" cy="13" r="2.5"></circle><path d="m17 18 2.5 2.5"></path></svg>';
const ICON_HISTORY = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>';
const ICON_COPY = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>';

// ── Optimistic update: mutate the local assignment, re-render its card
// immediately, THEN talk to the server. Mirrors exactly what the CRM page's
// content script does (see markInProgress/setOnHold there) — the person
// sees the change the instant they click, instead of waiting on a round
// trip that (per past Apps Script latency issues) can lag a couple seconds
// behind the write actually landing. Reverts the local mutation and
// re-renders again if the write comes back failed.
function applyOptimisticUpdate(a, name, patch, sendFn) {
  const previous = { ...a };
  Object.assign(a, patch);
  refreshCard(a, name);
  sendFn(() => {
    Object.assign(a, previous);
    refreshCard(a, name);
  });
}

// ── Sending a write action to background.js ─────────────────────────────
// Every write (Start/Hold/Downloaded) goes through the same background.js
// handlers the CRM content script already uses, so behavior (name-required
// guard, Sheet writes, history logging) stays identical between the two
// surfaces. Purely fire-and-verify here — the caller already updated the
// UI optimistically and only needs to know if it must be rolled back.
function dpSendAction(type, payload, onFailure) {
  chrome.runtime.sendMessage({ type, ...payload }, resp => {
    if (!resp || !resp.ok) {
      showToast((resp && resp.error) || "Action failed — please try again.");
      if (onFailure) onFailure();
    }
  });
}

// ── Auto-search on the CRM tab ───────────────────────────────────────────
// Same DP_AUTO_SEARCH flow the dashboard already uses to jump a ref into
// the CRM's own Photo Request search box (see handleAutoSearch in
// background.js) — it focuses/creates the CRM's requests tab, types the
// ref into the search box there, and fires the search. No name/role
// requirement, since this doesn't write anything.
function dpAutoSearch(ref) {
  if (!ref) return;
  chrome.runtime.sendMessage({ type: "DP_AUTO_SEARCH", ref }, resp => {
    if (!(resp && resp.ok)) {
      showToast((resp && resp.error) || "Could not search that reference on the CRM tab.");
    }
  });
}

// ── Toast ─────────────────────────────────────────────────────────────
let toastTimer = null;
function showToast(message) {
  let toast = document.getElementById("dpToast");
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "dpToast";
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.classList.add("is-visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("is-visible"), 2200);
}

// ── On Hold reason modal ─────────────────────────────────────────────────
function showOnHoldModal(existingReason, mode, onSave) {
  const prev = document.querySelector(".dp-modal-overlay");
  if (prev) prev.remove();

  const overlay = document.createElement("div");
  overlay.className = "dp-modal-overlay";
  overlay.addEventListener("click", e => { if (e.target === overlay) overlay.remove(); });

  const modal = document.createElement("div");
  modal.className = "dp-modal";
  overlay.appendChild(modal);

  const titleEl = document.createElement("h3");
  titleEl.className = "dp-modal-title";
  titleEl.textContent = mode === "view" ? "On Hold Reason" : existingReason ? "Update Hold Reason" : "Put on Hold";
  modal.appendChild(titleEl);

  const textarea = document.createElement("textarea");
  textarea.className = "dp-modal-textarea";
  textarea.value = existingReason || "";
  textarea.readOnly = mode === "view";
  textarea.placeholder = "Reason for putting this on hold…";
  modal.appendChild(textarea);

  const btnRow = document.createElement("div");
  btnRow.className = "dp-modal-btn-row";

  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.className = "dp-modal-cancel";
  cancelBtn.textContent = mode === "view" ? "Close" : "Cancel";
  cancelBtn.addEventListener("click", () => overlay.remove());
  btnRow.appendChild(cancelBtn);

  if (mode !== "view" && onSave) {
    const saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.className = "dp-modal-save";
    saveBtn.textContent = existingReason ? "Update Reason" : "Put on Hold";
    saveBtn.addEventListener("click", () => {
      onSave(textarea.value.trim());
      overlay.remove();
    });
    btnRow.appendChild(saveBtn);
  }

  modal.appendChild(btnRow);
  document.body.appendChild(overlay);
  if (mode !== "view") textarea.focus();
}

// ── Inline sliding history timeline ─────────────────────────────────────
// Reads straight from a.history (the raw per-listing event log already
// included in every DP_GET_ALL assignment record) — no separate fetch
// needed since the sidepanel always has the full list in hand already.
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

function fmtDT(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d)) return null;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) +
    " · " + d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
}

function historyEventDetail(e) {
  switch (e.type) {
    case "assigned":
      return [e.editor ? `To: ${e.editor}` : null, e.by ? `By: ${e.by}` : null]
        .filter(Boolean).join("  ·  ") || null;
    case "reassigned":
      return [e.from && e.to ? `${e.from} → ${e.to}` : null, e.by ? `By: ${e.by}` : null]
        .filter(Boolean).join("  ·  ") || null;
    case "unassigned":
      return [e.editor ? `From: ${e.editor}` : null, e.reason || null]
        .filter(Boolean).join("  ·  ") || null;
    case "onhold":
      return e.reason ? `Reason: ${e.reason}` : null;
    case "restarted":
      return e.by ? `By: ${e.by}` : null;
    case "downloaded":
      return e.editor ? `By: ${e.editor}` : null;
    case "downloaded_cleared":
      return e.reason || null;
    case "recategorized":
      return e.from && e.to ? `${e.from} → ${e.to}` : null;
    default:
      return null;
  }
}

function buildHistoryTimeline(panel, a) {
  panel.innerHTML = "";
  const inner = document.createElement("div");
  inner.className = "ac-timeline";

  const historyLog = Array.isArray(a.history) ? a.history : [];
  const events = historyLog
    .filter(e => e && e.type && e.ts && TIMELINE_EVENT_META[e.type])
    .map(e => ({ ...TIMELINE_EVENT_META[e.type], ts: e.ts, detail: historyEventDetail(e) }))
    .sort((x, y) => new Date(x.ts) - new Date(y.ts));

  if (events.length === 0) {
    const empty = document.createElement("div");
    empty.className = "ac-timeline-empty";
    empty.textContent = "No history tracked yet for this listing.";
    inner.appendChild(empty);
  } else {
    events.forEach((ev, i) => {
      const row = document.createElement("div");
      row.className = "ac-timeline-row";

      const dotWrap = document.createElement("div");
      dotWrap.className = "ac-timeline-dot-wrap";
      const dot = document.createElement("div");
      dot.className = "ac-timeline-dot";
      dot.style.background = ev.color;
      dotWrap.appendChild(dot);
      if (i < events.length - 1) {
        const line = document.createElement("div");
        line.className = "ac-timeline-line";
        dotWrap.appendChild(line);
      }
      row.appendChild(dotWrap);

      const content = document.createElement("div");
      content.className = "ac-timeline-content";
      const labelEl = document.createElement("span");
      labelEl.className = "ac-timeline-label";
      labelEl.textContent = ev.label;
      labelEl.style.color = ev.color;
      content.appendChild(labelEl);
      const timeEl = document.createElement("span");
      timeEl.className = "ac-timeline-time";
      timeEl.textContent = fmtDT(ev.ts);
      content.appendChild(timeEl);
      if (ev.detail) {
        const detailEl = document.createElement("span");
        detailEl.className = "ac-timeline-detail";
        detailEl.textContent = ev.detail;
        content.appendChild(detailEl);
      }
      row.appendChild(content);
      inner.appendChild(row);
    });
  }

  panel.appendChild(inner);
}

// ── Connection status check ────────────────────────────────────────────
const COPIER_APPS_SCRIPT_URL = 'https://script.google.com/a/macros/drivenproperties.com/s/AKfycbxRnU165B4OZoIyc-sDFrkQB-tePNsb9MBrMWJa7IRZuTWzzITQvxT6ES7eSCVzc6S-/exec';

async function checkConnection() {
  const connDot  = document.getElementById('dpConnDot');
  const connText = document.getElementById('dpConnText');

  const setState = (dotClass, message) => {
    if (connDot)  connDot.className  = dotClass;
    if (connText) connText.textContent = message;
  };

  setState('dot-warn', 'Checking…');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);

  try {
    const res = await fetch(COPIER_APPS_SCRIPT_URL, {
      method:   'POST',
      headers:  { 'Content-Type': 'text/plain' },
      body:     JSON.stringify({ ping: true }),
      redirect: 'follow',
      signal:   controller.signal,
    });

    if (!res.ok) throw new Error('HTTP ' + res.status);
    const json = await res.json();
    if (!json.success && !json.ping) throw new Error('Bad response');

    setState('dot-ok', '✅ Connected to Apps Script');

  } catch (err) {
    const message = err && err.name === 'AbortError' ? 'Timed out after 10s' : (err.message || String(err));
    setState('dot-error', '❌ Disconnected — ' + message);
  } finally {
    clearTimeout(timer);
  }
}

// ── Force Sync ────────────────────────────────────────────────────────────
// Re-checks the connection and re-fetches assignment data straight from the
// background worker, bypassing whatever's currently cached client-side —
// for exactly the kind of situation where something's written locally but
// doesn't seem to be landing in the Sheet, and a person wants to force a
// fresh look at what's actually true right now rather than wait for the
// next scheduled poll.
const dpForceSyncBtn = document.getElementById('dpForceSyncBtn');
if (dpForceSyncBtn) {
  dpForceSyncBtn.addEventListener('click', async () => {
    dpForceSyncBtn.disabled = true;
    dpForceSyncBtn.textContent = 'Syncing…';

    await checkConnection();

    chrome.storage.local.get(['myName'], ({ myName }) => {
      if (myName) {
        renderAssignmentsList(myName, { skipCache: true });
      }
      dpForceSyncBtn.disabled = false;
      dpForceSyncBtn.textContent = '⟳ Force Sync';
    });
  });
}

// ── Version footer ────────────────────────────────────────────────────────
const dpVersionText = document.getElementById("dpVersionText");
if (dpVersionText) {
  dpVersionText.textContent = "v" + chrome.runtime.getManifest().version;
}

// ── Auto-Refresh CRM (auto-click "All") ─────────────────────────────────
// The actual periodic clicking happens in background.js via chrome.alarms,
// so it keeps running even if this panel gets closed — all this does is
// read/write the setting in chrome.storage.local. background.js reacts to
// the storage change on its own; there's no message to send here.
const AUTO_ALL_CLICK_KEY   = "dpAutoAllClick";
const AUTO_ALL_CLICK_ALARM = "dpAutoAllClick"; // must match background.js's alarm name

function renderAutoAllUI(settings) {
  if (!autoAllToggle) return;
  const enabled = !!(settings && settings.enabled);
  const minutes = Math.min(60, Math.max(1, Number(settings && settings.intervalMinutes) || 5));

  autoAllToggle.checked = enabled;
  autoAllIntervalInput.value = String(minutes);
  autoAllIntervalValueEl.textContent = `${minutes} min`;
  autoAllIntervalWrap.style.display = enabled ? "block" : "none";

  if (enabled) startAutoAllCountdown(); else stopAutoAllCountdown();
}

function saveAutoAllClickSettings() {
  chrome.storage.local.set({
    [AUTO_ALL_CLICK_KEY]: {
      enabled: autoAllToggle.checked,
      intervalMinutes: Number(autoAllIntervalInput.value) || 5,
    },
  });
}

// ── Countdown to the next auto-click ────────────────────────────────────
// Reads the actual alarm's scheduledTime straight from chrome.alarms
// (rather than tracking our own timer here) so the number on screen can
// never drift out of sync with what background.js is really about to do.
let autoAllCountdownTimer = null;

function formatCountdown(ms) {
  const totalSec = Math.max(0, Math.round(ms / 1000));
  const mm = Math.floor(totalSec / 60);
  const ss = totalSec % 60;
  return `${mm}:${String(ss).padStart(2, "0")}`;
}

function tickAutoAllCountdown() {
  if (!autoAllCountdownEl) return;
  if (!autoAllToggle.checked) { autoAllCountdownEl.textContent = ""; return; }

  chrome.alarms.get(AUTO_ALL_CLICK_ALARM, alarm => {
    if (!autoAllToggle.checked) { autoAllCountdownEl.textContent = ""; return; }
    if (!alarm) { autoAllCountdownEl.textContent = "Starting…"; return; }

    const msLeft = alarm.scheduledTime - Date.now();
    autoAllCountdownEl.textContent = msLeft <= 500
      ? "Clicking now…"
      : `Next click in ${formatCountdown(msLeft)}`;
  });
}

function startAutoAllCountdown() {
  stopAutoAllCountdown();
  tickAutoAllCountdown();
  autoAllCountdownTimer = setInterval(tickAutoAllCountdown, 1000);
}

function stopAutoAllCountdown() {
  if (autoAllCountdownTimer) { clearInterval(autoAllCountdownTimer); autoAllCountdownTimer = null; }
  if (autoAllCountdownEl) autoAllCountdownEl.textContent = "";
}

// Pause the countdown's 1s ticking while the panel is hidden — pointless
// to keep polling chrome.alarms for a number nobody's looking at — and
// snap it back up to date the instant the panel is visible again.
document.addEventListener("visibilitychange", () => {
  if (!autoAllToggle || !autoAllToggle.checked) return;
  if (document.visibilityState === "visible") startAutoAllCountdown();
  else stopAutoAllCountdown();
});

if (autoAllToggle) {
  chrome.storage.local.get([AUTO_ALL_CLICK_KEY], result => renderAutoAllUI(result[AUTO_ALL_CLICK_KEY]));

  autoAllToggle.addEventListener("change", () => {
    autoAllIntervalWrap.style.display = autoAllToggle.checked ? "block" : "none";
    saveAutoAllClickSettings();
    if (autoAllToggle.checked) startAutoAllCountdown(); else stopAutoAllCountdown();
  });

  // "input" fires continuously while dragging — just update the live label
  // with that. "change" fires once on release — that's when we actually
  // persist and reset the alarm's interval, so dragging doesn't spam
  // chrome.storage.local (and re-arm the alarm) on every pixel of drag.
  autoAllIntervalInput.addEventListener("input", () => {
    autoAllIntervalValueEl.textContent = `${autoAllIntervalInput.value} min`;
  });
  autoAllIntervalInput.addEventListener("change", () => {
    saveAutoAllClickSettings();
    // Give background.js's storage.onChanged listener a beat to actually
    // re-arm the alarm with the new interval before we read it back.
    if (autoAllToggle.checked) setTimeout(tickAutoAllCountdown, 300);
  });
}

// ── Settings drawer ──────────────────────────────────────────────────────
// Bottom sheet holding Auto-Refresh CRM + Configuration. Slides up on open
// rather than living permanently in the page flow — see the CSS comment
// on .dp-settings-drawer for why.
const settingsOpenBtn  = document.getElementById("dpSettingsOpenBtn");
const settingsDrawer   = document.getElementById("dpSettingsDrawer");
const settingsBackdrop = document.getElementById("dpSettingsBackdrop");
const settingsCloseBtn = document.getElementById("dpSettingsCloseBtn");

function openSettingsDrawer() {
  if (!settingsDrawer) return;
  settingsDrawer.classList.add("is-open");
  if (settingsBackdrop) settingsBackdrop.classList.add("is-open");
  // Make sure Next up / On duty reflect the latest data the moment
  // someone actually looks at them, rather than whatever was last polled.
  renderAutoAssignSettings();
}

function closeSettingsDrawer() {
  if (!settingsDrawer) return;
  settingsDrawer.classList.remove("is-open");
  if (settingsBackdrop) settingsBackdrop.classList.remove("is-open");
}

if (settingsOpenBtn)  settingsOpenBtn.addEventListener("click", openSettingsDrawer);
if (settingsCloseBtn) settingsCloseBtn.addEventListener("click", closeSettingsDrawer);
if (settingsBackdrop) settingsBackdrop.addEventListener("click", closeSettingsDrawer);

// ── Configuration: Open in new tab ──────────────────────────────────────
// Moved here from the CRM page's own filter bar — writes the exact same
// chrome.storage.local key assigner-content.js already reads, and that
// file now also listens for this key changing live (see its
// chrome.storage.onChanged listener), so flipping this while a CRM tab is
// already open takes effect immediately, no reload needed.
const openNewTabToggle = document.getElementById("dpOpenNewTabToggle");
if (openNewTabToggle) {
  chrome.storage.local.get(["dpOpenListingNewTab"], result => {
    openNewTabToggle.checked = result.dpOpenListingNewTab === true;
  });
  openNewTabToggle.addEventListener("change", () => {
    chrome.storage.local.set({ dpOpenListingNewTab: openNewTabToggle.checked });
  });
}

// ── Configuration: Auto-assign ──────────────────────────────────────────
// Same live-storage-key relationship as Open in new tab above. One
// difference: assigner-content.js deliberately forces this back to OFF
// (and writes that OFF state back here) every time a CRM tab freshly loads
// — a safety net so the auto-assigner never silently keeps running off a
// stale "on" from a previous session. That means this toggle can appear to
// flip itself off if a CRM tab reloads while it was on; that's expected,
// not a bug — just flip it back on here to resume.
const autoAssignToggle = document.getElementById("dpAutoAssignToggle");
if (autoAssignToggle) {
  chrome.storage.local.get(["dpAutoAssignEnabled"], result => {
    autoAssignToggle.checked = result.dpAutoAssignEnabled === true;
  });
  autoAssignToggle.addEventListener("change", () => {
    chrome.storage.local.set({ dpAutoAssignEnabled: autoAssignToggle.checked });
  });

  // Keeps this toggle in sync if assigner-content.js resets it (see above)
  // while the drawer happens to be open, or from another instance of this
  // side panel.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.dpAutoAssignEnabled) {
      autoAssignToggle.checked = changes.dpAutoAssignEnabled.newValue === true;
    }
  });
}
