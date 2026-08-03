"use strict";

// Single source of truth for who is senior vs junior — shared with
// background.js's default and used to gate Assigner permissions in
// assigner-content.js. Add/move names here as the team changes.
const NAME_ROLES = {
  Harvy:   "senior",
  Alvin:   "senior",
  Mark:    "senior",
  Sudheep: "senior",
  Jabir:   "junior",
  Rohith:  "junior",
  Muneer:  "junior",
};
function roleForName(name) {
  return NAME_ROLES[name] || "junior"; // unknown names default to the safer role
}

// ── Elements ────────────────────────────────────────────────────────────
const setupDiv     = document.getElementById("setup");
const identityBar   = document.getElementById("identityBar");
const nameSelect    = document.getElementById("nameSelect");
const saveBtn       = document.getElementById("saveBtn");
const whoText       = document.getElementById("whoText");
const roleBadge     = document.getElementById("roleBadge");
const changeBtn     = document.getElementById("changeNameBtn");
const tabsDiv       = document.getElementById("tabs");

const listContainer = document.getElementById("listContainer");
const totalBadge    = document.getElementById("totalBadge");

const tabBtnAssign  = document.getElementById("tabBtnAssign");
const tabBtnLogger  = document.getElementById("tabBtnLogger");
const panelAssign   = document.getElementById("panelAssign");
const panelLogger   = document.getElementById("panelLogger");

// ── Identity ────────────────────────────────────────────────────────────
function showSetup() {
  setupDiv.style.display    = "block";
  identityBar.style.display = "none";
  tabsDiv.style.display     = "none";
}

function showMain(name, role) {
  setupDiv.style.display    = "none";
  identityBar.style.display = "flex";
  tabsDiv.style.display     = "block";

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

  // Recompute role from the roster every time the popup opens, so a
  // promotion/demotion just needs an edit to NAME_ROLES above — no
  // reinstall or manual storage reset needed.
  const role = roleForName(name);
  if (role !== result.role) chrome.storage.local.set({ role });
  nameSelect.value = name;
  showMain(name, role);
});

// ── Tabs ────────────────────────────────────────────────────────────────
function activateTab(tab) {
  const isAssign = tab === "assign";
  tabBtnAssign.classList.toggle("is-active", isAssign);
  tabBtnLogger.classList.toggle("is-active", !isAssign);
  panelAssign.classList.toggle("is-active", isAssign);
  panelLogger.classList.toggle("is-active", !isAssign);
}
tabBtnAssign.addEventListener("click", () => activateTab("assign"));
tabBtnLogger.addEventListener("click", () => activateTab("logger"));

// ═══════════════════════════════════════════════════════════════════════
// ASSIGNMENTS TAB (Photo Assigner)
// ═══════════════════════════════════════════════════════════════════════

function statusPillClass(status) {
  if (status === "Assigned")    return "assigned";
  if (status === "In Progress") return "inprogress";
  return "assigned";
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
    active.forEach(a => {
      const row = document.createElement("div");
      row.className = "listing-row";

      const refEl = document.createElement("span");
      refEl.className = "listing-ref";
      refEl.textContent = a.ref;
      row.appendChild(refEl);

      const pill = document.createElement("span");
      pill.className = `status-pill ${statusPillClass(a.status)}`;
      pill.textContent = a.status;
      row.appendChild(pill);

      listContainer.appendChild(row);
    });

    totalBadge.innerHTML = `Total: <span>${active.length}</span>`;
  });
}

// ═══════════════════════════════════════════════════════════════════════
// LISTING LOGGER TAB (DP Listing Copier)
// ═══════════════════════════════════════════════════════════════════════

const logLifestyleBtn   = document.getElementById("log-lifestyle-btn");
const lifestyleFeedback = document.getElementById("lifestyle-feedback");

function setLifestyleFeedback(msg, type) {
  lifestyleFeedback.textContent = msg;
  lifestyleFeedback.className   = "feedback " + (type || "");
}

logLifestyleBtn.addEventListener("click", async () => {
  const lifestyle = parseInt(document.getElementById("lifestyle-count").value || 0, 10);
  const profile   = parseInt(document.getElementById("profile-count").value   || 0, 10);
  const others    = parseInt(document.getElementById("others-count").value    || 0, 10);

  if (lifestyle === 0 && profile === 0 && others === 0) {
    setLifestyleFeedback("❌ Please enter at least one count.", "error");
    return;
  }
  if (lifestyle < 0 || profile < 0 || others < 0) {
    setLifestyleFeedback("❌ Counts cannot be negative.", "error");
    return;
  }

  const { myName: editorName } = await chrome.storage.local.get(["myName"]);
  if (!editorName) {
    setLifestyleFeedback("❌ Select your name first.", "error");
    return;
  }

  logLifestyleBtn.textContent = "Logging…";
  logLifestyleBtn.disabled    = true;
  setLifestyleFeedback("Sending…", "");

  chrome.runtime.sendMessage(
    { type: "LOG_LIFESTYLE", payload: { lifestyle, profile, others } },
    (response) => {
      logLifestyleBtn.textContent = "Log Lifestyle / Profile / Others";
      logLifestyleBtn.disabled    = false;

      if (chrome.runtime.lastError) {
        setLifestyleFeedback("❌ " + chrome.runtime.lastError.message, "error");
        return;
      }

      if (response?.success) {
        document.getElementById("lifestyle-count").value = "";
        document.getElementById("profile-count").value  = "";
        document.getElementById("others-count").value   = "";
        const parts = [];
        if (lifestyle > 0) parts.push(lifestyle + " Lifestyle");
        if (profile   > 0) parts.push(profile   + " Profile");
        if (others    > 0) parts.push(others     + " Others");
        setLifestyleFeedback("✅ Logged: " + parts.join(", ") + " for " + editorName, "ok");
      } else {
        setLifestyleFeedback("❌ " + (response?.error || "Unknown error"), "error");
      }
    }
  );
});

// ── Connection status check ────────────────────────────────────────────
const COPIER_APPS_SCRIPT_URL = 'https://script.google.com/a/macros/drivenproperties.com/s/AKfycbxRnU165B4OZoIyc-sDFrkQB-tePNsb9MBrMWJa7IRZuTWzzITQvxT6ES7eSCVzc6S-/exec';

async function checkConnection() {
  const dot      = document.getElementById('status-dot');
  const text     = document.getElementById('status-text');
  const connDot  = document.getElementById('dpConnDot');
  const connText = document.getElementById('dpConnText');

  const setState = (dotClass, message) => {
    if (dot)  dot.className  = 'status-dot ' + dotClass;
    if (text) text.textContent = message;
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
