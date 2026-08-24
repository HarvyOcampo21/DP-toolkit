"use strict";

// Single source of truth for who is senior vs junior — shared with
// background.js's default and used to gate Assigner permissions in
// assigner-content.js. Add/move names here as the team changes.
const NAME_ROLES = {
  Harvy:   "senior",
  Mark:    "senior",
  Sudheep: "senior",
  Jabir:   "senior",
};
function roleForName(name) {
  return NAME_ROLES[name] || "junior"; // unknown names default to the safer role
}

// ── Elements ────────────────────────────────────────────────────────────
const setupDiv      = document.getElementById("setup");
const identityBar    = document.getElementById("identityBar");
const nameSelect     = document.getElementById("nameSelect");
const saveBtn        = document.getElementById("saveBtn");
const whoText        = document.getElementById("whoText");
const roleBadge      = document.getElementById("roleBadge");
const changeBtn      = document.getElementById("changeNameBtn");
const assignSection  = document.getElementById("assignSection");

const listContainer  = document.getElementById("listContainer");
const totalBadge     = document.getElementById("totalBadge");

// ── Identity ────────────────────────────────────────────────────────────
function showSetup() {
  setupDiv.style.display     = "block";
  identityBar.style.display  = "none";
  assignSection.style.display = "none";
}

function showMain(name, role) {
  setupDiv.style.display      = "none";
  identityBar.style.display   = "flex";
  assignSection.style.display = "block";

  whoText.textContent = `Hi, ${name}!`;
  roleBadge.textContent = role === "senior" ? "Senior" : "Junior";
  roleBadge.className   = "badge " + (role === "senior" ? "badge-senior" : "badge-junior");

  renderAssignmentsList(name);
  checkConnection();
}

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

chrome.storage.local.get(["myName", "role"], result => {
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

function bedsLabel(bedrooms) {
  if (bedrooms === "" || bedrooms === null || bedrooms === undefined || bedrooms === "?") return null;
  if (bedrooms === "0" || bedrooms === 0) return "Studio";
  return `${bedrooms} bed${bedrooms === "1" || bedrooms === 1 ? "" : "s"}`;
}

function renderAssignmentsList(name) {
  listContainer.innerHTML = '<div class="loading">Loading…</div>';
  if (totalBadge) totalBadge.innerHTML = "";

  chrome.runtime.sendMessage({ type: "DP_GET_ALL" }, resp => {
    if (!resp || !resp.ok || !resp.data || !Array.isArray(resp.data.assignments)) {
      listContainer.innerHTML = '<div class="empty-state">Could not load listings.</div>';
      return;
    }

    const active = resp.data.assignments.filter(a =>
      a.editor === name && ACTIVE_STATUSES.includes(a.status)
    );

    if (active.length === 0) {
      listContainer.innerHTML = '<div class="empty-state">No active assignments — all clear!</div>';
      totalBadge.innerHTML = "";
      return;
    }

    listContainer.innerHTML = "";
    active.forEach(a => listContainer.appendChild(buildAssignCard(a)));

    totalBadge.innerHTML = `Total: <span>${active.length}</span>`;
  });
}

function buildAssignCard(a) {
  const card = document.createElement("div");
  card.className = "assign-card";

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
  top.appendChild(listingRefEl);

  const type = listingType(a.listingRef);
  if (type) {
    const tag = document.createElement("span");
    tag.className = "ac-type-tag " + (type === "rental" ? "ac-type-rental" : "ac-type-sales");
    tag.textContent = type === "rental" ? "RENTAL" : "SALES";
    top.appendChild(tag);
  }
  card.appendChild(top);

  const reqRef = document.createElement("div");
  reqRef.className = "ac-req-ref";
  reqRef.textContent = a.ref || "";
  card.appendChild(reqRef);

  const beds = bedsLabel(a.bedrooms);
  if (beds) {
    const bedsRow = document.createElement("div");
    bedsRow.className = "ac-beds";
    bedsRow.textContent = beds;
    card.appendChild(bedsRow);
  }

  const bottomRow = document.createElement("div");
  bottomRow.className = "ac-bottom-row";

  const categoryClass = CATEGORY_CLASS[a.crmStatus];
  if (categoryClass) {
    const cat = document.createElement("span");
    cat.className = "ac-category " + categoryClass;
    cat.textContent = a.crmStatus;
    bottomRow.appendChild(cat);
  }

  if (a.status) {
    const status = document.createElement("span");
    status.className = "ac-status";
    status.textContent = a.status;
    if (colors) status.style.color = colors.border;
    bottomRow.appendChild(status);
  }

  card.appendChild(bottomRow);

  // ── Actions row: Start / Hold / Restart / View Reason ──────────────────
  const actionsRow = document.createElement("div");
  actionsRow.className = "ac-actions-row";

  const isOnHold  = a.status === "On Hold";
  const isRejected = a.status === "Rejected";
  const isActive  = a.status === "Assigned" || a.status === "In Progress" || a.status === "On Hold";

  if (a.status === "Assigned" || a.status === "On Hold") {
    actionsRow.appendChild(mkActionBtn("Start", "ac-start-btn", () => {
      dpSendAction("DP_MARK_INPROGRESS", { ref: a.ref, title: a.title }, name);
    }));
  }

  if (isRejected) {
    actionsRow.appendChild(mkActionBtn("Restart", "ac-start-btn", () => {
      dpSendAction("DP_RESTART_REJECTED", { ref: a.ref, title: a.title }, name);
    }, "Reopen this listing as a new cycle and reassign it back to you"));
  }

  if (isActive) {
    actionsRow.appendChild(mkActionBtn("Hold", "ac-hold-btn", () => {
      showOnHoldModal("", "edit", reason => {
        dpSendAction("DP_SET_ON_HOLD", { ref: a.ref, reason, title: a.title }, name);
      });
    }, "Put on hold with reason"));
  }

  if (isOnHold) {
    actionsRow.appendChild(mkActionBtn("View Reason", "ac-reason-btn", () => {
      showOnHoldModal(a.onHoldReason || "", "edit", reason => {
        dpSendAction("DP_SET_ON_HOLD", { ref: a.ref, reason, title: a.title }, name);
      });
    }, "See why this listing is on hold"));
  }

  if (actionsRow.childNodes.length) card.appendChild(actionsRow);

  // ── Icon row: Drive search / History (sliding) / Copy ref ──────────────
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

  card.appendChild(iconRow);
  card.appendChild(historyPanel);

  // ── Downloaded checkbox ─────────────────────────────────────────────────
  const downloadedLabel = document.createElement("label");
  downloadedLabel.className = "ac-downloaded-wrap";
  downloadedLabel.title = "Mark as downloaded from Drive";
  const downloadedCheckbox = document.createElement("input");
  downloadedCheckbox.type = "checkbox";
  downloadedCheckbox.checked = !!a.downloaded;
  downloadedCheckbox.addEventListener("change", () => {
    const val = downloadedCheckbox.checked;
    const downloadedAt = val ? new Date().toISOString() : "";
    dpSendAction("DP_SET_DOWNLOADED",
      { ref: a.ref, downloaded: val, downloadedAt, title: a.title }, name,
      () => { downloadedCheckbox.checked = !val; }); // revert on failure
  });
  const downloadedText = document.createElement("span");
  downloadedText.textContent = "Downloaded";
  downloadedLabel.appendChild(downloadedCheckbox);
  downloadedLabel.appendChild(downloadedText);
  card.appendChild(downloadedLabel);

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

// ── Sending a write action to background.js, then refreshing the list ────
// Every write (Start/Hold/Restart/Downloaded) goes through the same
// background.js handlers the CRM content script already uses, so behavior
// (name-required guard, Sheet writes, history logging) stays identical
// between the two surfaces. On success we just re-fetch the active list
// rather than hand-patching this one card's DOM — simplest way to stay
// correct if the status change also means the card should drop out of
// "active" (e.g. eventually Completed/Rejected elsewhere).
function dpSendAction(type, payload, name, onFailure) {
  chrome.runtime.sendMessage({ type, ...payload }, resp => {
    if (!resp || !resp.ok) {
      showToast((resp && resp.error) || "Action failed — please try again.");
      if (onFailure) onFailure();
      return;
    }
    if (name) renderAssignmentsList(name);
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
        renderAssignmentsList(myName);
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
