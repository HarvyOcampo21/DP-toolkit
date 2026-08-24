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
      a.editor === name && a.status === "Assigned"
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

  const categoryClass = CATEGORY_CLASS[a.crmStatus];
  if (categoryClass) {
    const cat = document.createElement("span");
    cat.className = "ac-category " + categoryClass;
    cat.textContent = a.crmStatus;
    card.appendChild(cat);
  }

  return card;
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
