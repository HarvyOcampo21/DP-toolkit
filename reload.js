// DP Toolkit update wizard — runs across two separate loads of this same
// page:
//
//   Load 1 (opened directly by update-dp-toolkit.command, no query param):
//     "Reload the extension now?" -> yes reloads it, no shows a reminder.
//
//   Load 2 (opened by background.js right after the reload finishes,
//   ?step=post): proves the reload actually worked by showing the live
//   version number, then asks about refreshing CRM tabs.
//
// Why two separate page loads instead of one continuous script: calling
// chrome.runtime.reload() tears down this page's own execution context
// almost immediately, taking any in-progress code with it — including
// every already-injected content script in already-open CRM tabs. That's
// also why the CRM-tab refresh confirmation lives here, in a freshly
// opened extension tab, rather than trying to message an existing CRM
// tab's content script right after reloading: that content script is
// exactly the thing the reload just invalidated, so a message sent to it
// at that moment never has a listener there to receive it.

const card = document.getElementById("card");
const isPostReload = new URLSearchParams(location.search).get("step") === "post";

function render(html) {
  card.innerHTML = html;
}

function showConfirm({ title, body, onYes, onNo }) {
  render(`
    <h2>${title}</h2>
    <p>${body}</p>
    <div class="btn-row">
      <button class="btn-no" id="noBtn">No</button>
      <button class="btn-yes" id="yesBtn">Yes</button>
    </div>
  `);
  document.getElementById("yesBtn").addEventListener("click", onYes);
  document.getElementById("noBtn").addEventListener("click", onNo);
}

function showReminder(text) {
  render(`<p class="reminder">⚠️ ${text}</p>`);
}

function showDone(text, closeAfterMs) {
  render(`<p class="done">✅ ${text}</p>`);
  if (closeAfterMs) setTimeout(() => window.close(), closeAfterMs);
}

// ── Step 1: ask whether to reload the extension ──────────────────────────
function stepReloadExtension() {
  showConfirm({
    title: "DP Toolkit update ready",
    body: "The latest files have been synced. Reload the extension now to apply them?",
    onYes: () => {
      render(`<p>Reloading…</p>`);
      // dpPendingPostReloadTab is picked up by background.js once it
      // restarts fresh — see the top-level check in background.js for why
      // this can't just be a setTimeout in this script instead.
      chrome.storage.local.set({ dpPendingPostReloadTab: Date.now() }, () => {
        chrome.runtime.reload();
      });
    },
    onNo: () => {
      showReminder("Please manually reload the extension via chrome://extensions to apply the update.");
    },
  });
}

// ── Step 2 (this tab was opened fresh by background.js, after the
// extension already finished reloading) ──────────────────────────────────
function stepPostReload() {
  const version = chrome.runtime.getManifest().version;
  render(`<h2 class="done">✅ Extension reloaded — now running <span class="version">v${version}</span></h2>`);

  chrome.tabs.query({ url: "https://newcrm.drivenproperties.com/*" }, tabs => {
    if (tabs.length === 0) {
      showDone("No open CRM tabs to refresh. You can close this tab.", 2500);
      return;
    }

    const plural = tabs.length === 1 ? "tab" : "tabs";
    showConfirm({
      title: `Extension reloaded — v${version}`,
      body: `Refresh ${tabs.length} open CRM ${plural} now?`,
      onYes: () => {
        let remaining = 5;
        const tick = () => {
          render(`<div class="countdown">${remaining}</div><p>Refreshing ${tabs.length} CRM ${plural}...</p>`);
        };
        tick();
        const iv = setInterval(() => {
          remaining -= 1;
          if (remaining <= 0) {
            clearInterval(iv);
            tabs.forEach(t => { if (t.id !== undefined) chrome.tabs.reload(t.id); });
            showDone("All CRM tabs refreshed. You can close this tab.", 2000);
            return;
          }
          tick();
        }, 1000);
      },
      onNo: () => {
        showReminder("Please manually refresh your open CRM tab(s) to get the latest update.");
      },
    });
  });
}

if (isPostReload) stepPostReload();
else stepReloadExtension();
