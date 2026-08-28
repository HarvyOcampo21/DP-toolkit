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
    "The Google Drive search button now opens under YOUR OWN company account, based on the name you picked in the popup \u2014 previously it always forced everyone's search into one specific editor's account.",
  ]},
  { version: 37, notes: [
    "The Drive search account fix from v36 is now fully automatic \u2014 it detects whichever @drivenproperties.com account Chrome itself is signed into, no name needs to be picked first, and there's no list of names/emails to keep updated as the team changes.",
  ]},
  { version: 38, notes: [
    "Reverted the v37 auto-detect approach for Drive search \u2014 it wasn't reliably picking up the signed-in account. Back to deriving the account from the name picked in the popup (v36's approach).",
  ]},
  { version: 39, notes: [
    "Fixed Time History never showing when a listing was downloaded \u2014 the timestamp was being tracked but was getting dropped on every refresh before it could display.",
  ]},
  { version: 40, notes: [
    "Fixed Time History also missing \u201cAssigned by\u201d and reassignment details \u2014 same root cause as the v39 download-time fix, now closed for every field the timeline shows.",
  ]},
  { version: 41, notes: [
    "Completed listings now auto-reopen for reassignment too when the CRM shows genuinely new work waiting (e.g. an agent requests a reshoot of a property that already had its photos completed) \u2014 previously this only worked for Rejected listings.",
    "Reopening also clears the \u201cDownloaded\u201d checkbox now, since old downloads belong to the previous shoot, not the new one.",
    "Time History now shows the full reopen story \u2014 category change, the old download being cleared, and the reset \u2014 not just the parts that already had a place to display.",
  ]},
  { version: 42, notes: [
    "\u201cQC Approved\u201d and \u201cStock Photos QC Approved\u201d are now treated the same as \u201cPhotos For QC\u201d and \u201cStock Photos For QC\u201d for category tracking \u2014 previously these approved-status variants weren't recognized at all, so they were silently ignored by category tracking and reopen-on-recategorize.",
    "Removed Rohith, Alvin, and Muneer from the name list.",
  ]},
  { version: 43, notes: [
    "Completing a listing marked \u201cQC Approved\u201d or \u201cStock Photos QC Approved\u201d now logs to the Sheet automatically \u2014 List Type set to Agent Request, with the correct sub-type (Use my own photos / Stock photos) picked automatically \u2014 same as Offplan/Upload Pending already did. Still governed by the same auto-log toggle, so turning that off stops all of this at once.",
  ]},
    { version: 44, notes: [
    "Backend split for speed — Assignment data now runs on its own dedicated server, so it won't slow down or get slowed down by other activity",
  ]},
      { version: 47, notes: [
    "Added a \u201cMonth\u201d filter to the Assignment board \u2014 shows everything assigned so far this month, right alongside Today, This Week, and Last 7 Days.",
  ]},
      { version: 48, notes: [
    "Each listing's reference number (e.g. DP-S-49080, DP-R-65511) is now captured and saved alongside its assignment \u2014 separate from the internal request number, so it's available even when the listing isn't open on screen.",
  ]},
      { version: 49, notes: [
    "Fixed rejected/completed listings not reopening for reassignment when the CRM's status came back to the SAME category as before (e.g. Photos For QC \u2192 rejected \u2192 Photos For QC again) \u2014 this now works the same as when it comes back under a different category.",
    "Each rework cycle is now tracked as its own entry, so completed/rejected counts stay accurate no matter how many times a listing gets reshot \u2014 and Time History now shows the full story across every cycle, start to finish.",
  ]},
      { version: 50, notes: [
    "The assigned agent's name is now captured and logged automatically on Complete, Reject, and manual Log to Sheet \u2014 no more needing to hover the agent's photo yourself to see who it was.",
  ]},
      { version: 51, notes: [
    "Added a round-robin auto-assign toggle for seniors \u2014 when on, new Unassigned listings are assigned automatically to whoever has the fewest assignments so far today, so the day's workload stays evenly spread without anyone needing to track it by hand. Resets on its own every day.",
    "The Assign popover now shows each editor's assignment count for today and stars whoever the round-robin recommends next \u2014 useful for picking manually too, whether or not auto-assign is turned on.",
  ]},
      { version: 52, notes: [
    "Auto-assign now staggers itself with a brief random delay and re-checks a listing is still unassigned right before writing \u2014 avoids two seniors' tabs both auto-assigning the same brand-new listing at the same moment when more than one senior has the board open.",
  ]},
      { version: 53, notes: [
    "Closed the remaining gap from v52: if two seniors' tabs still both attempt to auto-assign the exact same listing at once, the server now rejects the second one instead of silently overwriting the first \u2014 the losing tab corrects itself immediately instead of showing the wrong editor for a few seconds. Manual assigning/reassigning is unaffected.",
  ]},
      { version: 54, notes: [
    "Listings assigned by the round-robin auto-assigner now show \u201cAuto-assign (Name)\u201d as the Assigned By, instead of just the picking senior's name \u2014 so Time History makes it clear the system assigned it automatically, while still showing whose device it ran on. Manual assigns/reassigns are unchanged.",
  ]},
      { version: 55, notes: [
    "Auto-assign now only fires while the CRM's own status still shows Upload Pending, Offplan Pending, Photos For QC, or Stock Photos For QC \u2014 previously it could pick up other rows too. Manual assigning/reassigning is unaffected.",
  ]},
      { version: 56, notes: [
    "Auto-assign now always starts OFF on every fresh page load or refresh \u2014 it no longer remembers being left on from a previous session, so it always has to be turned on by hand.",
  ]},
      { version: 57, notes: [
    "Fixed auto-assign silently skipping eligible Unassigned listings that just sat there without ever getting picked up \u2014 it was only ever retrying a listing when its status changed, so one missed attempt (e.g. right as the tab was still loading) meant it was never tried again. It now keeps checking every eligible listing on every refresh until it's actually assigned.",
  ]},
      { version: 58, notes: [
    "Fixed a data race that could corrupt a listing's row on the Assignments sheet when several listings were being auto-assigned close together \u2014 Editor and Status would save correctly, but Assigned Date, Assigned By, and Time History could end up blank. The two background writes involved no longer step on each other, and any row that does get created bare now gets properly filled in the moment it's actually assigned. Existing rows that already have this gap will heal themselves the next time that listing is assigned or reassigned.",
  ]},
      { version: 59, notes: [
    "Added an \u201cOn duty\u201d picker next to Auto-assign, for seniors \u2014 choose exactly which editors the auto-assigner is allowed to hand new listings to. Only checked editors are ever picked, so on a day where only some of the team is working (or someone's out sick or on leave), auto-assign will only spread work across whoever's actually checked \u2014 no need to touch this at all on a normal day where everyone's in.",
  ]},
      { version: 60, notes: [
    "Restart (on a Rejected listing) now opens it as a proper new cycle \u2014 tracked as its own entry, same as a reshoot coming back automatically \u2014 and hands it straight back to the same editor who had it, ready to go as Assigned. It no longer jumps straight to In Progress; the editor still hits Start themselves once they actually pick it back up.",
  ]},
      { version: 61, notes: [
    "Fixed Time History only showing the CURRENT cycle for a listing that's been reopened or restarted \u2014 e.g. after a Restart, it was only showing this round's Assigned/Started/Completed and silently dropping the original assignment, the rejection, and the restart itself, even though that's all still on record. Time History now always shows the complete story from the very first Assigned through every cycle since.",
  ]},
      { version: 62, notes: [
    "Fixed auto-reopen recreating the same Unassigned listing over and over even after deleting it from the sheet by hand \u2014 if the CRM's live category kept reading differently from what was on file, it would just keep reopening indefinitely with no memory that it had already done so. It now remembers, permanently, so deleting it for good actually sticks.",
  ]},
      { version: 63, notes: [
    "Cleaned up the filter bar \u2014 Bedrooms is now a plain borderless button that reveals the same filter chips on hover, instead of always taking up space in the row.",
    "Open in new tab, Auto-assign, and On duty are now tucked behind a single \u2699 settings icon that opens on hover, instead of each having their own permanent spot in the bar.",
    "Both have smooth open/close animations, and both also open on keyboard focus \u2014 not hover-only.",
  ]},
      { version: 64, notes: [
    "Fixed a leftover empty gap above the filter bar from the v63 cleanup.",
    "The \u2699 settings icon no longer shows a background box on hover, and is now sized to exactly match the height of the Editor/Status buttons next to it.",
  ]},
      { version: 65, notes: [
    "The toolbar icon now opens a side panel instead of a small popup, so it can stay open next to the CRM while you work.",
    "Active assignments now show as cards with the listing reference, the photo request reference, bedrooms, and a Rental/Sales tag \u2014 instead of a bare reference and status pill.",
    "Removed the \u201cListing Logger\u201d tab (Log Lifestyle/Profile/Others) \u2014 it wasn't being used.",
  ]},
      { version: 66, notes: [
    "Assignment cards in the side panel are now tinted by status (Assigned, In Progress, On Hold, Rejected, Completed) using the same colors as the highlighted rows on the CRM page, with the status shown at the bottom right of the card.",
    "On Hold listings now show up in Active Assignments too, not just Assigned \u2014 an On Hold listing is still yours, just paused.",
  ]},
      { version: 67, notes: [
    "Side panel assignment cards now have the same actions as the CRM page \u2014 Start, Hold, View/Update Reason, Drive search, Copy reference, and a Downloaded checkbox \u2014 so you can manage a listing without switching over to the CRM tab.",
    "Time History in the side panel now opens inline right on the card, sliding open in place instead of a popup, and pushes the rest of the list down as it expands.",
    "Fixed a bug where starting a listing from the side panel made its card disappear from Active Assignments \u2014 In Progress listings now correctly stay visible, same as Assigned and On Hold.",
  ]},
      { version: 68, notes: [
    "Fixed Start/Hold on the side panel not visibly changing a card's status \u2014 it now updates the card the instant you click, instead of waiting on a refetch from Apps Script that could take a few seconds to reflect the write.",
  ]},
      { version: 69, notes: [
    "The side panel no longer shows a blank \u201cLoading\u2026\u201d every time it's opened \u2014 it now shows your last-known assignments instantly, then quietly refreshes from the Sheet in the background. Start, Hold, and Downloaded are saved to that same local snapshot the moment you use them, so reopening the panel right after never shows stale data.",
    "Force Sync now explicitly skips this snapshot and goes straight to a fresh fetch, same as before.",
  ]},
      { version: 70, notes: [
    "Both reference numbers on a side panel card \u2014 the listing ref and the DP-REQ number \u2014 are now clickable. Tapping either jumps to your CRM tab (opening one if you don't have it open) and searches that reference for you, same as the dashboard's click-to-search already did.",
  ]},
      { version: 71, notes: [
    "Redesigned side panel cards: status now sits beside the Rental/Sales pill, Start/Hold/View Reason now sit beside the category pill, and the Downloaded checkbox now sits beside the copy-reference button \u2014 fewer rows, easier to scan.",
    "Removed the bedroom count from side panel cards.",
    "The side panel now quietly refreshes itself every few seconds while it's open, so a listing you (or a teammate) complete on the CRM tab disappears from Active Assignments on its own \u2014 no more needing to reopen the panel or hit Force Sync to see it drop off.",
  ]},
      { version: 72, notes: [
    "Clicking a reference number to auto-search the CRM (from the side panel, the dashboard, or a notification) now targets your second open CRM tab instead of your first, if you have more than one open.",
    "Added category filter tabs to the top of the side panel's Active Assignments list \u2014 All, QC, Offplan Pending, and Upload Pending. \"Photos For QC\" and \"Stock Photos For QC\" both live under the combined QC tab. Your last-used tab is remembered next time you open the panel.",
  ]},
      { version: 73, notes: [
    "Removed the redundant \"DP Toolkit\" header from inside the side panel \u2014 Chrome already shows the icon and title in its own side panel header bar, so ours was just repeating it. The Senior/Junior badge that used to live up there now sits right next to your name instead.",
    "Category filter tabs no longer sit in an enclosing box \u2014 just the icons themselves now, matching a plain Chrome tab strip more closely.",
  ]},
      { version: 74, notes: [
    "Fixed the category filter tabs' count badges getting clipped at the top and right edge.",
  ]},
      { version: 75, notes: [
    "Quick Links and the connection/Force Sync footer are now pinned to the bottom of the side panel at all times \u2014 only the assignment card list scrolls, so these no longer end up buried far down the page when you've got a long list, or floating awkwardly high up when you've got a short one.",
    "Added a \"Today's Activity\" line above Quick Links showing how many listings you've completed and rejected today, plus a running total. It's read straight from each listing's own history log, so it naturally resets itself at midnight \u2014 nothing to clear manually.",
  ]},
      { version: 76, notes: [
    "Added an \"Auto-Refresh CRM\" toggle to the side panel. Switch it on and, every 1\u201360 minutes (set with the slider that appears once it's on), the toolkit clicks the \"All\" filter on the Photo Requests board for you on every open CRM tab \u2014 an easy way to keep the board's data current without remembering to click it yourself. Runs in the background, so it keeps going even with the side panel closed; flip the toggle off to stop it.",
  ]},
      { version: 77, notes: [
    "Auto-Refresh CRM now shows a live countdown to the next auto-click, right under the interval slider.",
    "Auto-Refresh CRM now only clicks \"All\" on your first open CRM tab, instead of every open CRM tab.",
  ]},
      { version: 78, notes: [
    "Added a Settings drawer to the side panel \u2014 tap the new \"Settings\" button to slide it up from the bottom, tap outside it (or the \u2715) to slide it back down. Auto-Refresh CRM now lives inside it instead of sitting permanently in the page.",
    "Moved Configuration \u2014 Open in new tab, Auto-assign, and On duty (seniors only) \u2014 out of the CRM page's own filter bar and into that same Settings drawer. Flipping any of them updates the CRM tab immediately, no reload needed. Auto-assign still resets to off every time a CRM tab freshly loads, same safety behavior as before, so the drawer's toggle can visibly flip itself off when that happens \u2014 that's expected, not a bug.",
    "The \"Next up\" round-robin recommendation is now computed and shown right in the side panel too, next to the Auto-assign toggle.",
  ]},
      { version: 79, notes: [
    "Removed the now-unused toggle-switch CSS left behind on the CRM page from last version's move of Configuration into the side panel.",
  ]},
      { version: 80, notes: [
    "Moved Quick Links into the Settings drawer, alongside Auto-Refresh CRM and Configuration.",
    "Moved \"Next up\" out of the Settings drawer and up to Today's Activity, so the round-robin recommendation is visible without opening the drawer (seniors only, same as before). The Auto-Refresh CRM countdown now also shows a live copy right next to it whenever auto-refresh is turned on.",
    "Fixed the \"Could not refresh\" warning popping up repeatedly (roughly every 5 seconds) while a refresh kept failing. It now only shows once when a refresh first starts failing, not on every retry after that.",
  ]},
      { version: 81, notes: [
    "Completed listings now always show a Restart button, for when new work comes in on something already finished (e.g. an agent requests a reshoot). Restart hands it straight back to the same editor as Assigned — same behavior as the existing Restart on Rejected listings — and is tracked as its own new entry, so your Completed counts stay accurate.",
    "When a Completed listing's CRM category has genuinely come back with new work AND it still has an existing photo on file, you'll now also see a \u201cPossible re-shoot\u201d note next to it \u2014 a heads-up that the current thumbnail may be outdated. This is purely informational and doesn't touch the Sheet on its own \u2014 nothing is logged until you actually click Restart.",
  ]},
      { version: 82, notes: [
    "Auto-assign now only ever fires from the first CRM tab (left-to-right in the tab strip) when more than one is open in the same browser, instead of every open tab independently racing to assign the same fresh listing. If that tab gets closed, the next CRM tab in line automatically takes over within a few seconds \u2014 nothing to reconfigure.",
    "Force Sync in the side panel now also pushes an immediate refresh into every open CRM tab, not just the side panel's own list \u2014 so a tab that's been sitting in the background catches up right away instead of waiting on its next scheduled poll.",
  ]},
      { version: 83, notes: [
    "The side panel now polls at the same rate as the CRM tab \u2014 3s while it's actually visible, 15s in the background \u2014 instead of a flat 5s only while visible and nothing at all while hidden.",
    "Every assignment action (assign, start, complete, reject, hold, downloaded, restart, etc.) now immediately pushes a refresh out to every open CRM tab AND the side panel the moment it lands in the Sheet, rather than waiting on each one's own next poll. Do something on the CRM tab and the side panel updates almost instantly, and vice versa.",
    "DP_GET_ALL and every write to the Sheet now explicitly bypass the browser's HTTP cache (cache: \"no-store\"), on top of the endpoint already being uncached server-side \u2014 belt-and-suspenders to guarantee every read and write is a genuine live round-trip, never a stale cached response.",
  ]},
      { version: 84, notes: [
    "The side panel's Start/Hold/Downloaded buttons now give a write the same ~45 seconds of patience as the CRM tab already does before actually reverting anything on a failed response, instead of snapping back to the old value on the very first flaky reply. Apps Script's write can genuinely still succeed even when the response back to the browser fails, so this checks a few more times over that window before concluding it truly didn't go through.",
  ]},
      { version: 85, notes: [
    "The \u201cNext up\u201d auto-assign indicator (CRM filter bar and side panel Settings drawer) now updates the instant an assignment happens on the tab that made it, instead of waiting on the next regular refresh pass. It was already pushed live to every other open tab/panel within about a second (see v83); this closes the last bit of lag on the originating tab itself.",
  ]},
      { version: 86, notes: [
    "CRM \u2194 side panel sync is now genuinely instant in both directions, not just \u201cwithin about a second.\u201d Every action (Start, Hold, Downloaded, assign, complete, reject, restart, etc.) is now pushed directly from wherever it happened to every other open CRM tab and the side panel the moment it's clicked \u2014 before the Sheet write even finishes, not after. Google Sheets stays the source of truth for persistence, but it's no longer the trigger for the visual update.",
    "Fixed a real flicker bug: a background poll landing at just the wrong moment (after a click, but before that click's own write had actually finished saving) could revert a correct optimistic status change back to the old value for a few seconds before self-correcting. Both surfaces now protect a fresh local change for a full 50 seconds \u2014 long enough to comfortably outlast a slow write \u2014 so a still-in-flight action can no longer be overwritten by stale data. This was already partly true on the CRM tab; the side panel had no such protection at all until now.",
  ]},
      { version: 87, notes: [
    "Auto-assign and Auto-Refresh CRM are now scoped per Chrome window instead of shared across the whole browser \u2014 turning either one on or off in one window's side panel no longer touches any other window's automation, including one parked on a different macOS Space. Each window elects its own \u201cfirst CRM tab\u201d independently for auto-assign, and gets its own independent refresh schedule for Auto-Refresh CRM, so two windows can run completely different automation states at the same time without interfering with each other. A window's automation settings are also now cleaned up automatically once that window is closed.",
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
