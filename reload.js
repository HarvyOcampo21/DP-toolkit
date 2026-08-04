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

// What's new, per version — shown on the "reload now?" step for every
// version newer than whatever's currently running, so someone who hasn't
// updated in a while sees everything they've missed, not just the latest
// entry. Add a new entry here each time a real change ships. Keep these
// short and in plain, user-facing language (what changed / why it helps),
// not implementation detail.
const CHANGELOG = [
  { version: 20, notes: [
    "Listings now show a colored border/background based on status (assigned, in progress, on hold, rejected, completed) so you can scan the list at a glance.",
    "Fixed a bug where everything briefly looked unassigned right after the page loaded.",
    "Added an optional \u201cOpen in new tab\u201d mode for listings.",
    "Backend speed improvements \u2014 less waiting when assigning, completing, or refreshing.",
  ]},
  { version: 21, notes: ["Added a one-click self-update tool for pulling the latest version."] },
  { version: 22, notes: ["The update tool now also refreshes your open CRM tabs automatically."] },
  { version: 23, notes: ["You can now see which version you're running at the bottom of the popup."] },
  { version: 24, notes: ["CRM tabs now wait a moment before refreshing, so nothing reloads before it's ready."] },
  { version: 25, notes: ["History now opens instantly instead of sometimes taking up to a minute to load."] },
  { version: 26, notes: ["You'll now see a heads-up countdown before your CRM tabs refresh."] },
  { version: 27, notes: ["You're now asked before any CRM tab refreshes \u2014 so you won't lose unsaved work on a tab you meant to keep open."] },
  { version: 28, notes: ["Rejected listings now automatically reopen for reassignment once new photos come back from a reshoot \u2014 no more manually noticing and fixing it."] },
  { version: 29, notes: ["Reworked the update flow to be more reliable \u2014 the reload confirmation now actually works every time."] },
  { version: 30, notes: ["CRM tabs now refresh immediately when you say yes, instead of waiting for the countdown first."] },
  { version: 31, notes: ["The update screen now shows you what's new before you reload, instead of updating blind."] },
  { version: 32, notes: ["The popup now shows a live connection status to Apps Script at all times, plus a \u201cForce Sync\u201d button to re-check the connection and re-fetch the latest data on demand."] },
  { version: 33, notes: ["Fixed a bug where assigning, starting, holding, rejecting, or completing a listing could show a false \u201creverted\u201d error and undo itself, even though it had actually saved correctly \u2014 it now double-checks before giving up."] },
  { version: 34, notes: [
    "The Assignment board now updates far faster \u2014 refreshing roughly every 3 seconds while you're actively viewing it, instead of every 15.",
    "Background tabs you're not currently looking at check in less often, so the faster refresh doesn't slow things down overall \u2014 switching back to a tab refreshes it immediately.",
  ]},
  { version: 35, notes: [
    "Fixed a bigger version of the v33 bug: assigning, starting, holding, rejecting, or completing a listing could still show a false \u201creverted\u201d error under normal load, even though the save was still quietly finishing on the server \u2014 it now gives a slow-but-real save several extra seconds to land before ever showing an error.",
  ]},
  { version: 36, notes: [
    "Fixed a follow-on to the v35 fix: a listing could briefly flicker back to its old status a few seconds after you completed/assigned/held/rejected it, then correct itself back \u2014 caused by the same \u201cgive it more time\u201d fix not yet covering that gap. It's now covered for the same amount of time, so this shouldn't happen anymore.",
  ]},
];

const card = document.getElementById("card");
const isPostReload = new URLSearchParams(location.search).get("step") === "post";

function render(html) {
  card.innerHTML = html;
}

function showConfirm({ title, body, onYes, onNo }) {
  render(`
    <h2>${title}</h2>
    ${body}
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
  // The manifest still reflects the OLD version here — the new files are
  // already synced to disk, but nothing's loaded them into memory yet,
  // since that only happens once chrome.runtime.reload() actually runs
  // below. That's exactly what makes this useful: it tells us precisely
  // what's new to THIS person, whether they update daily or haven't in a
  // while, rather than always just showing the latest single entry.
  const currentVersion = parseInt(chrome.runtime.getManifest().version, 10) || 0;
  const newEntries = CHANGELOG.filter(e => e.version > currentVersion);

  let changelogHtml = "";
  if (newEntries.length > 0) {
    const items = newEntries.flatMap(e => e.notes).map(note => `<li>${note}</li>`).join("");
    changelogHtml = `
      <p style="text-align:left;font-weight:700;margin-bottom:6px;">What's new:</p>
      <ul style="text-align:left;font-size:0.8rem;color:#c7cbd8;line-height:1.6;
                 margin:0 0 16px 0;padding-left:18px;max-height:220px;overflow-y:auto;">
        ${items}
      </ul>
    `;
  }

  showConfirm({
    title: "DP Toolkit update ready",
    body: `
      <p>The latest files have been synced.</p>
      ${changelogHtml}
      <p>Reload the extension now to apply ${newEntries.length > 0 ? "these updates" : "them"}?</p>
    `,
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
      body: `<p>Refresh ${tabs.length} open CRM ${plural} now?</p>`,
      onYes: () => {
        // Reload the tabs right away — the countdown below is just a
        // heads-up telling the person to wait before switching over to
        // them, not something the actual refresh is gated behind. If the
        // reload waited until the countdown finished, "0" wouldn't
        // actually mean the tabs are ready — it'd mean they just started
        // loading. Firing immediately gives the page load that time to
        // actually finish in the background while the countdown runs.
        tabs.forEach(t => { if (t.id !== undefined) chrome.tabs.reload(t.id); });

        let remaining = 5;
        const tick = () => {
          render(`<div class="countdown">${remaining}</div><p>Refreshing ${tabs.length} CRM ${plural}\u2014give it a moment before switching over.</p>`);
        };
        tick();
        const iv = setInterval(() => {
          remaining -= 1;
          if (remaining <= 0) {
            clearInterval(iv);
            showDone("Should be ready now. You can close this tab.", 2000);
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
