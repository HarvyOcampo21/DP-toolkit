/**
 * DP Assigner — Standalone Google Apps Script
 * Split off from the original combined DP Toolkit script so Assigner
 * traffic (frequent polling + writes from every editor's extension) no
 * longer shares an execution quota, script lock, or spreadsheet file with
 * Copier traffic (editor tab logging, Lifestyle, Amenities, etc).
 *
 * Bound to its own dedicated spreadsheet containing ONLY the Assignments
 * tab (copied over from the original spreadsheet). The Copier-side script
 * stays exactly as-is in the original project/spreadsheet — untouched.
 *
 * Deploy: Extensions > Apps Script (in the NEW spreadsheet) > paste this in
 * > Deploy > New deployment > Web app > Execute as: Me, Who has access: Anyone.
 */

// ── Config ──────────────────────────────────────────────────────────────
var SHEET_ID = "1LgD2PXXdzJI_ryTXSgl3GPIRZSbaoF1lO4EVZtL4Ogo"; // new dedicated Assignments spreadsheet

const ASSIGNER_TOKEN = "DPPE"; // unchanged — extension/dashboard don't need updating for this
const ASSIGNER_SHEET_NAME = "Assignments";
const ASSIGNER_ARCHIVE_SHEET_NAME = "Assignments Archive";
const AUTO_ASSIGN_CONFIG_SHEET_NAME = "AutoAssignConfig";
const ASSIGNER_TRACKED_CATEGORIES = ["Offplan Pending", "Photos For QC", "Stock Photos For QC", "Upload Pending", "Re-shoot"];
const ASSIGNER_HEADERS = [
  "Ref","Title","Editor","Status",
  "AssignedAt","UpdatedAt","Downloaded","DownloadedAt",
  "CompletedAt","StartedAt","RejectedAt","OnHoldAt","OnHoldReason",
  "AssignedBy",
  "ReassignedFrom","ReassignedTo","ReassignedBy","ReassignedAt",
  "Bedrooms","Category","UnassignedAt",
  "History",
  "ListingRef"
];
const ASSIGNER_COL = {
  REF:1,TITLE:2,EDITOR:3,STATUS:4,
  ASSIGNED_AT:5,UPDATED_AT:6,DOWNLOADED:7,DOWNLOADED_AT:8,
  COMPLETED_AT:9,STARTED_AT:10,REJECTED_AT:11,ON_HOLD_AT:12,ON_HOLD_REASON:13,
  ASSIGNED_BY:14,
  REASSIGNED_FROM:15,REASSIGNED_TO:16,REASSIGNED_BY:17,REASSIGNED_AT:18,
  BEDROOMS:19,CRM_STATUS:20,UNASSIGNED_AT:21,
  HISTORY:22,
  LISTING_REF:23
};

// Archiving cutoff — Completed/Rejected rows whose UpdatedAt is older than
// this many days get moved out of the live tab on the daily trigger below.
// Keep this generous at first (90 days) since the whole point of this
// split was speed, not aggressive pruning — tighten later if needed.
var ARCHIVE_AFTER_DAYS = 90;

// ── Entry points ────────────────────────────────────────────────────────
// No routing needed anymore — every request on this deployment IS an
// Assigner request. Kept the token check as-is for auth continuity.
function doGet(e) {
  var token = e && e.parameter ? e.parameter.token : null;
  if (token) return getAssignerAssignments(token);
  return jsonResponse({ success: true, ping: true });
}

function doPost(e) {
  try {
    var payload = JSON.parse(e.postData.contents);
    if (payload.ping) return jsonResponse({ success: true, ping: true });
    return assignerDoPost(payload);
  } catch (err) {
    return jsonResponse({ success: false, error: 'Parse error: ' + err.message });
  }
}

function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ── Append-only event log ────────────────────────────────────────────────
function parseHistory(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}
function appendHistory(raw, event) {
  const arr = parseHistory(raw);
  arr.push(event);
  return JSON.stringify(arr.length > 200 ? arr.slice(arr.length - 200) : arr);
}

function getAssignerSheet() {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  let sheet = ss.getSheetByName(ASSIGNER_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(ASSIGNER_SHEET_NAME);
    sheet.appendRow(ASSIGNER_HEADERS);
    return sheet;
  }
  const lastCol = sheet.getLastColumn();
  if (lastCol < ASSIGNER_HEADERS.length)
    sheet.getRange(1, lastCol+1, 1, ASSIGNER_HEADERS.length-lastCol).setValues([ASSIGNER_HEADERS.slice(lastCol)]);
  if (sheet.getLastColumn() >= ASSIGNER_COL.CRM_STATUS) {
    const headerCell = sheet.getRange(1, ASSIGNER_COL.CRM_STATUS);
    if (headerCell.getValue() === "CrmStatus") headerCell.setValue("Category");
  }
  return sheet;
}

function getArchiveSheet() {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  let sheet = ss.getSheetByName(ASSIGNER_ARCHIVE_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(ASSIGNER_ARCHIVE_SHEET_NAME);
    sheet.appendRow(ASSIGNER_HEADERS);
    const hr = sheet.getRange(1, 1, 1, ASSIGNER_HEADERS.length);
    hr.setFontWeight("bold");
    hr.setBackground("#6b7280");
    hr.setFontColor("#ffffff");
    sheet.setFrozenRows(1);
  }
  return sheet;
}

// ── Auto-assign eligibility (who's on duty) ───────────────────────────────
// Lives on its own small tab (Editor | Eligible) rather than in the same
// row-per-listing Assignments sheet — this is per-EDITOR config, not
// per-listing data, and changes independently (a senior flips someone off
// duty; that has nothing to do with any particular Ref). Only ever created
// here defensively if genuinely missing — the real one already has rows
// for every editor, hand-maintained.
function getAutoAssignConfigSheet() {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  let sheet = ss.getSheetByName(AUTO_ASSIGN_CONFIG_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(AUTO_ASSIGN_CONFIG_SHEET_NAME);
    sheet.appendRow(["Editor", "Eligible"]);
  }
  return sheet;
}

// Reads the whole tab into { editorName: true/false }. An editor with NO
// row at all is treated as eligible by default — this tab only needs an
// entry for someone you want to exclude from today's rotation, not a row
// kept in sync for every name just to stay included.
function readAutoAssignConfig() {
  const sheet = getAutoAssignConfigSheet();
  const rows = sheet.getDataRange().getValues();
  rows.shift();
  const config = {};
  rows.forEach(r => { if (r[0]) config[String(r[0]).trim()] = isTruthyCell(r[1]); });
  return config;
}

// Toggles one editor's Eligible cell (or appends a new row for them if this
// is the first time they've ever been toggled). Not tied to any Ref, so
// this has its own small find-by-name lookup rather than reusing
// findRowIndex (which is Ref-column-specific).
function setAutoAssignEligibility(editorName, eligible) {
  const name = (editorName || "").trim();
  if (!name) return jsonResponse({ error: "Missing editor" });
  const sheet = getAutoAssignConfigSheet();
  const data = sheet.getDataRange().getValues();
  let ri = -1;
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]).trim() === name) { ri = i + 1; break; }
  }
  if (ri === -1) sheet.appendRow([name, !!eligible]);
  else sheet.getRange(ri, 2).setValue(!!eligible);
  return jsonResponse({ ok: true, editor: name, eligible: !!eligible });
}

function checkToken(t) { return t === ASSIGNER_TOKEN; }
// Searches bottom-up rather than top-down — a Ref can now have more than one
// row (see reopenOnCategoryChange, which appends a new row instead of
// overwriting when a listing comes back for a fresh cycle), and new rows are
// always appended after old ones. Bottom-up guarantees every write action
// (assign, syncMeta, markCompleted, etc.) always targets the CURRENT cycle,
// never a stale older one, without any of them needing to know duplicates
// exist at all.
function findRowIndex(data, ref) {
  for (let i = data.length - 1; i >= 1; i--) if (data[i][0] === ref) return i + 1;
  return -1;
}
function isTruthyCell(v) { return v === true || v === "TRUE" || v === "true"; }
// Mirrors the client's isActiveStatus() (assigner-content.js) exactly —
// "spoken for" means any real status other than blank/Unassigned. Used
// below to let an auto-triggered assign back off if the row is no longer
// eligible by the time this request actually gets to run under the lock.
function isActiveAssignmentStatus(status) { return !!status && status !== "Unassigned"; }
function fmt(d) {
  if (d === null || d === undefined || d === "") return "";
  if (typeof d === "object" && typeof d.getTime === "function") {
    const t = d.getTime();
    return isNaN(t) ? "" : new Date(t).toISOString();
  }
  if (typeof d === "number" && !isNaN(d)) {
    const jsDate = new Date((d - 25569) * 86400 * 1000);
    return isNaN(jsDate.getTime()) ? "" : jsDate.toISOString();
  }
  if (typeof d === "string" && d.trim()) {
    const parsed = new Date(d);
    return isNaN(parsed.getTime()) ? "" : parsed.toISOString();
  }
  return "";
}

// ── GET: return all tracked assignments ──────────────────────────────────
function getAssignerAssignments(token) {
  if (!checkToken(token)) return jsonResponse({ error: "Unauthorized" });

  const sheet = getAssignerSheet();
  const rows = sheet.getDataRange().getValues();
  rows.shift();
  const json = JSON.stringify({
    assignments: rows.filter(r => r[0]).map(r => ({
    ref:             r[0],
    title:           r[1],
    editor:          r[2],
    status:          r[3],
    assignedAt:      fmt(r[4]),
    updatedAt:       fmt(r[5]),
    downloaded:      isTruthyCell(r[6]),
    downloadedAt:    fmt(r[7]),
    completedAt:     fmt(r[8]),
    startedAt:       fmt(r[9]),
    rejectedAt:      fmt(r[10]),
    onHoldAt:        fmt(r[11]),
    onHoldReason:    r[12] || "",
    assignedBy:      r[13] || "",
    reassignedFrom:  r[14] || "",
    reassignedTo:    r[15] || "",
    reassignedBy:    r[16] || "",
    reassignedAt:    fmt(r[17]),
    bedrooms:        r[18] || "",
    crmStatus:       r[19] || "",
    unassignedAt:    fmt(r[20]),
    history:         parseHistory(r[21]),
    listingRef:      r[22] || "",
    })),
    // Sent alongside every regular fetch (rather than needing its own
    // separate poll) so the "who's on duty" state is always as fresh as
    // the assignment data itself — see readAutoAssignConfig above.
    autoAssignConfig: readAutoAssignConfig(),
  });

  return ContentService
    .createTextOutput(json)
    .setMimeType(ContentService.MimeType.JSON);
}

// ── POST: handle all write actions ───────────────────────────────────────
function assignerDoPost(p) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(30000);
  } catch (err) {
    return jsonResponse({ error: "Server busy, please retry" });
  }
  try {
    return assignerDoPost_impl(p);
  } finally {
    lock.releaseLock();
  }
}

function assignerDoPost_impl(p) {
  if (!checkToken(p.token)) return jsonResponse({ error: "Unauthorized" });

  // Not tied to a Ref at all (it's per-editor config), so this is handled
  // before the "Missing ref" check just below.
  if (p.action === "setAutoAssignEligibility") {
    return setAutoAssignEligibility(p.editor, p.eligible);
  }

  if (!p.ref) return jsonResponse({ error: "Missing ref" });

  const sheet = getAssignerSheet();
  const data = sheet.getDataRange().getValues();
  const ri = findRowIndex(data, p.ref);
  const now = new Date();

  function ex(col) {
    return (ri > 0 && data[ri-1][col-1] !== undefined) ? data[ri-1][col-1] : "";
  }

  function fullRow(overrides) {
    return [
      overrides.ref         !== undefined ? overrides.ref         : ex(ASSIGNER_COL.REF),
      overrides.title       !== undefined ? overrides.title       : ex(ASSIGNER_COL.TITLE),
      overrides.editor      !== undefined ? overrides.editor      : ex(ASSIGNER_COL.EDITOR),
      overrides.status      !== undefined ? overrides.status      : ex(ASSIGNER_COL.STATUS),
      overrides.assignedAt  !== undefined ? overrides.assignedAt  : ex(ASSIGNER_COL.ASSIGNED_AT),
      overrides.updatedAt   !== undefined ? overrides.updatedAt   : ex(ASSIGNER_COL.UPDATED_AT),
      overrides.downloaded  !== undefined ? overrides.downloaded  : ex(ASSIGNER_COL.DOWNLOADED),
      overrides.downloadedAt!== undefined ? overrides.downloadedAt: ex(ASSIGNER_COL.DOWNLOADED_AT),
      overrides.completedAt !== undefined ? overrides.completedAt : ex(ASSIGNER_COL.COMPLETED_AT),
      overrides.startedAt   !== undefined ? overrides.startedAt   : ex(ASSIGNER_COL.STARTED_AT),
      overrides.rejectedAt  !== undefined ? overrides.rejectedAt  : ex(ASSIGNER_COL.REJECTED_AT),
      overrides.onHoldAt    !== undefined ? overrides.onHoldAt    : ex(ASSIGNER_COL.ON_HOLD_AT),
      overrides.onHoldReason   !== undefined ? overrides.onHoldReason   : ex(ASSIGNER_COL.ON_HOLD_REASON),
      overrides.assignedBy     !== undefined ? overrides.assignedBy     : ex(ASSIGNER_COL.ASSIGNED_BY),
      overrides.reassignedFrom !== undefined ? overrides.reassignedFrom : ex(ASSIGNER_COL.REASSIGNED_FROM),
      overrides.reassignedTo   !== undefined ? overrides.reassignedTo   : ex(ASSIGNER_COL.REASSIGNED_TO),
      overrides.reassignedBy   !== undefined ? overrides.reassignedBy   : ex(ASSIGNER_COL.REASSIGNED_BY),
      overrides.reassignedAt   !== undefined ? overrides.reassignedAt   : ex(ASSIGNER_COL.REASSIGNED_AT),
      overrides.bedrooms       !== undefined ? overrides.bedrooms       : ex(ASSIGNER_COL.BEDROOMS),
      overrides.crmStatus      !== undefined ? overrides.crmStatus      : ex(ASSIGNER_COL.CRM_STATUS),
      overrides.unassignedAt   !== undefined ? overrides.unassignedAt   : ex(ASSIGNER_COL.UNASSIGNED_AT),
      overrides.history        !== undefined ? overrides.history        : ex(ASSIGNER_COL.HISTORY),
      overrides.listingRef     !== undefined ? overrides.listingRef     : ex(ASSIGNER_COL.LISTING_REF),
    ];
  }

  // ── unassign ─────────────────────────────────────────────────────────
  if (p.action === "unassign") {
    if (ri > -1) {
      const historyJson = appendHistory(ex(ASSIGNER_COL.HISTORY), {
        type: "unassigned", ts: now.toISOString(), editor: ex(ASSIGNER_COL.EDITOR),
      });
      sheet.getRange(ri, 1, 1, ASSIGNER_HEADERS.length).setValues([fullRow({
        editor: "", status: "Unassigned", updatedAt: now, unassignedAt: now, history: historyJson,
      })]);
    }
    return jsonResponse({ ref: p.ref, cleared: true });
  }

  // ── syncMeta ──────────────────────────────────────────────────────────
  // Passively persists bedroom count + task category + listing reference
  // (the DP-S-/DP-R-/etc. reference badge, distinct from Ref which is the
  // internal DP-REQ photo-request number) — all otherwise only known from
  // the CRM page's DOM — so the Dashboard can read them back without
  // depending on the listing still being loaded on screen.
  // Category is write-once: once set, it's never overwritten. ListingRef
  // and Bedrooms are NOT write-once — a listing's physical reference number
  // and bedroom count shouldn't normally change, but if the CRM is ever
  // corrected, overwriting keeps this in sync rather than freezing on a
  // stale first-seen value forever.
  //
  // Real no-op short-circuit: the content script's own dedupe cache lives
  // per-tab and resets on every page reload / new tab, so in practice this
  // fires far more often than the data actually changes — every open CRM
  // tab re-confirms metadata on every poll pass regardless. Rather than
  // trust the client to only call this on real changes, the server checks
  // for itself: if bedrooms/category/title/listingRef would all resolve to
  // the exact same values already on file, skip the write (and the
  // UpdatedAt bump) entirely rather than paying for a no-op setValues +
  // lock hold. This is what keeps write volume down (and UpdatedAt
  // meaningful) regardless of how many tabs are open or how often they poll.
  if (p.action === "syncMeta") {
    const bedrooms   = p.bedrooms   !== undefined && p.bedrooms   !== null ? String(p.bedrooms)   : "";
    const crmStatus  = ASSIGNER_TRACKED_CATEGORIES.indexOf(p.crmStatus) > -1 ? p.crmStatus : "";
    const title      = p.title || "";
    const listingRef = (p.listingRef || "").trim();
    if (ri > -1) {
      const bedroomsChanged   = !!bedrooms   && bedrooms   !== String(ex(ASSIGNER_COL.BEDROOMS) || "");
      const categoryChanged   = !!crmStatus  && !ex(ASSIGNER_COL.CRM_STATUS); // write-once
      const titleChanged      = !!title      && title      !== ex(ASSIGNER_COL.TITLE);
      const listingRefChanged = !!listingRef && listingRef !== String(ex(ASSIGNER_COL.LISTING_REF) || "");

      if (!bedroomsChanged && !categoryChanged && !titleChanged && !listingRefChanged) {
        return jsonResponse({ ref: p.ref, synced: true, skipped: true });
      }

      const overrides = { updatedAt: now };
      if (bedroomsChanged) overrides.bedrooms = bedrooms;
      if (categoryChanged) overrides.crmStatus = crmStatus;
      if (listingRefChanged) overrides.listingRef = listingRef;
      if (titleChanged) overrides.title = title;
      sheet.getRange(ri, 1, 1, ASSIGNER_HEADERS.length).setValues([fullRow(overrides)]);
    } else if (p.editor || p.status) {
      // Deliberately NEVER writes editor/status here, even though the
      // client only calls syncMeta when it already believes some status
      // exists (see the client's own guard in syncMetaIfNeeded). That
      // belief can be based on a purely LOCAL, not-yet-confirmed
      // optimistic update — e.g. auto-assign marks a listing "Assigned"
      // in the client's cache the instant it's triggered, well before the
      // server confirms it. If syncMeta's own independent request happens
      // to reach the server first (races ahead of the real "assign"
      // request — more likely the more listings are being auto-assigned
      // at once), and it wrote that premature editor/status here, the
      // real assign write that follows would see a row that already
      // looks Assigned and back off, permanently leaving AssignedAt/
      // AssignedBy/History blank on an otherwise-real assignment (exactly
      // the corrupted-row symptom this was causing). Leaving editor/
      // status out of this creation path means the worst a race can do is
      // pre-create a bare metadata row (bedrooms/category/title/
      // listingRef only) — the authoritative assign/hold/complete/reject
      // action that follows is always the one to actually establish
      // editor+status+timestamps+history, never this passive sync.
      sheet.appendRow(fullRow({ ref: p.ref, title, updatedAt: now, bedrooms, crmStatus, listingRef }));
    }
    return jsonResponse({ ref: p.ref, synced: true });
  }

  // ── setDownloaded ─────────────────────────────────────────────────────
  if (p.action === "setDownloaded") {
    const dl    = !!p.downloaded;
    const title = p.title || ex(ASSIGNER_COL.TITLE);
    if (ri > -1) {
      const overrides = { downloaded: dl, downloadedAt: dl ? now : "", updatedAt: now };
      if (title) overrides.title = title;
      if (dl) {
        overrides.history = appendHistory(ex(ASSIGNER_COL.HISTORY), {
          type: "downloaded", ts: now.toISOString(), editor: ex(ASSIGNER_COL.EDITOR),
        });
      }
      sheet.getRange(ri, 1, 1, ASSIGNER_HEADERS.length).setValues([fullRow(overrides)]);
    } else if (dl) {
      sheet.appendRow(fullRow({ ref: p.ref, title, downloaded: true, downloadedAt: now, updatedAt: now,
        history: appendHistory("", { type: "downloaded", ts: now.toISOString(), editor: p.editor || "" }) }));
    }
    return jsonResponse({ ref: p.ref, downloaded: dl });
  }

  // ── markInProgress ────────────────────────────────────────────────────
  if (p.action === "markInProgress") {
    const startedAt = ex(ASSIGNER_COL.STARTED_AT) || now;
    const isFirstStart = !ex(ASSIGNER_COL.STARTED_AT);
    if (ri > -1) {
      const overrides = { status: "In Progress", startedAt, onHoldAt: "", onHoldReason: "", updatedAt: now };
      if (p.title) overrides.title = p.title;
      if (isFirstStart) {
        overrides.history = appendHistory(ex(ASSIGNER_COL.HISTORY), {
          type: "started", ts: now.toISOString(), editor: ex(ASSIGNER_COL.EDITOR),
        });
      }
      sheet.getRange(ri, 1, 1, ASSIGNER_HEADERS.length).setValues([fullRow(overrides)]);
    } else {
      sheet.appendRow(fullRow({ ref: p.ref, title: p.title || "", editor: p.editor || "",
        status: "In Progress", updatedAt: now, startedAt: now,
        history: appendHistory("", { type: "started", ts: now.toISOString(), editor: p.editor || "" }) }));
    }
    return jsonResponse({ ref: p.ref, status: "In Progress", startedAt: fmt(startedAt) });
  }

  // ── markCompleted ─────────────────────────────────────────────────────
  if (p.action === "markCompleted") {
    const completedAt = ex(ASSIGNER_COL.COMPLETED_AT) || now;
    const isFirstComplete = !ex(ASSIGNER_COL.COMPLETED_AT);
    const historyJson = isFirstComplete
      ? appendHistory(ex(ASSIGNER_COL.HISTORY), { type: "completed", ts: now.toISOString(), editor: p.editor || ex(ASSIGNER_COL.EDITOR) })
      : ex(ASSIGNER_COL.HISTORY);
    if (ri > -1) {
      sheet.getRange(ri, 1, 1, ASSIGNER_HEADERS.length).setValues([fullRow({
        editor: p.editor || ex(ASSIGNER_COL.EDITOR),
        title:  p.title  || ex(ASSIGNER_COL.TITLE),
        status: "Completed",
        updatedAt: now,
        completedAt,
        history: historyJson,
      })]);
    } else {
      sheet.appendRow(fullRow({ ref: p.ref, title: p.title || "", editor: p.editor || "",
        status: "Completed", updatedAt: now, completedAt: now,
        history: appendHistory("", { type: "completed", ts: now.toISOString(), editor: p.editor || "" }) }));
    }
    return jsonResponse({ ref: p.ref, status: "Completed", completedAt: fmt(completedAt) });
  }

  // ── markRejected ──────────────────────────────────────────────────────
  if (p.action === "markRejected") {
    const isNewRejection = ex(ASSIGNER_COL.STATUS) !== "Rejected";
    const rejectedAt = isNewRejection ? now : (ex(ASSIGNER_COL.REJECTED_AT) || now);
    if (ri > -1) {
      const overrides = { status: "Rejected", rejectedAt, updatedAt: now };
      if (p.title)  overrides.title  = p.title;
      if (p.editor) overrides.editor = p.editor || ex(ASSIGNER_COL.EDITOR);
      if (isNewRejection) {
        overrides.history = appendHistory(ex(ASSIGNER_COL.HISTORY), {
          type: "rejected", ts: now.toISOString(), editor: p.editor || ex(ASSIGNER_COL.EDITOR),
        });
      }
      sheet.getRange(ri, 1, 1, ASSIGNER_HEADERS.length).setValues([fullRow(overrides)]);
    } else {
      sheet.appendRow(fullRow({ ref: p.ref, title: p.title || "", editor: p.editor || "",
        status: "Rejected", updatedAt: now, rejectedAt: now,
        history: appendHistory("", { type: "rejected", ts: now.toISOString(), editor: p.editor || "" }) }));
    }
    return jsonResponse({ ref: p.ref, status: "Rejected", rejectedAt: fmt(rejectedAt) });
  }

  // ── setOnHold ─────────────────────────────────────────────────────────
  if (p.action === "setOnHold") {
    const reason = p.reason || "";
    if (ri > -1) {
      const overrides = {
        status: "On Hold", onHoldAt: now, onHoldReason: reason, updatedAt: now,
        history: appendHistory(ex(ASSIGNER_COL.HISTORY), {
          type: "onhold", ts: now.toISOString(), editor: ex(ASSIGNER_COL.EDITOR), reason: reason,
        }),
      };
      if (p.title) overrides.title = p.title;
      sheet.getRange(ri, 1, 1, ASSIGNER_HEADERS.length).setValues([fullRow(overrides)]);
    } else {
      sheet.appendRow(fullRow({ ref: p.ref, title: p.title || "", editor: "",
        status: "On Hold", updatedAt: now, onHoldAt: now, onHoldReason: reason,
        history: appendHistory("", { type: "onhold", ts: now.toISOString(), editor: "", reason: reason }) }));
    }
    return jsonResponse({ ref: p.ref, status: "On Hold", onHoldAt: fmt(now) });
  }

  // ── reopenOnCategoryChange ──────────────────────────────────────────────
  // Handles a specific real-world pattern: a listing gets Rejected while
  // its category is one of the tracked ones, a reshoot gets booked, and
  // eventually the CRM's own category badge advances to a tracked category
  // again — meaning genuinely new work is now waiting.
  //
  // Only fires when the *current* assignment status is exactly "Rejected",
  // and the newly-observed category is any tracked category — including
  // the SAME one as before (e.g. Photos For QC → Rejected → Approved →
  // Photos For QC again is a completely normal rejection/rework cycle, not
  // a bug, and needs to reopen just as much as a genuine category change
  // does). There's no risk of this firing repeatedly on every poll: the
  // moment it fires, the newest row for this Ref flips to "Unassigned", so
  // reopenableFrom is false on every subsequent check until someone acts
  // on it again.
  //
  // NOTE: "Completed" used to be reopenable here too, but that meant a
  // Completed listing coming back (e.g. an agent requesting a reshoot)
  // silently wrote a brand-new row to the Sheet the moment the CRM's
  // category advanced — before anyone had actually decided a reshoot was
  // needed. That's now purely a client-side UI indicator (a "possible
  // re-shoot" note plus an always-available Restart button — see
  // assigner-content.js) and the Sheet is only ever touched once a person
  // deliberately clicks Restart, via the restartCompleted action below.
  //
  // Rather than overwrite the existing row in place, the old row's Status,
  // every timestamp, and every other column stay frozen exactly as they
  // were the moment it was Rejected/Completed — this is what keeps
  // historical counts (e.g. "how many Photos For QC jobs has Sudheep
  // completed") permanently accurate even after a listing cycles through
  // multiple rounds of rework, each cycle its own row, counted
  // independently. The ONE exception is its History cell, which gets a
  // small marker appended (see the idempotency guard below) — that's
  // display/audit data only, nothing reads it for counts, so it doesn't
  // compromise any of the above.
  //
  // A brand-new row is appended instead: same Ref, reset to Unassigned and
  // open for anyone to pick up, Downloaded cleared (old photos belong to
  // the old shoot), the new Category set, and every per-cycle timestamp
  // column (AssignedAt, StartedAt, CompletedAt, RejectedAt, OnHoldAt,
  // AssignedBy, Reassigned*) reset to blank for the new cycle. Ref, Title,
  // Bedrooms, and ListingRef carry forward automatically (fullRow's ex()
  // fallback pulls them from the old row for anything not explicitly
  // overridden here) since those describe the physical listing, not the
  // work cycle. History starts fresh — just this new row's own
  // recategorized/downloaded_cleared/unassigned events — rather than
  // carrying the old row's History forward. The old row keeps its own
  // History exactly as it was (aside from the idempotency marker below).
  // The two are stitched back together into one continuous timeline on
  // read, not on write — see the History modal's multi-row reconstruction
  // in assigner-content.js, which concatenates every row sharing a Ref.
  if (p.action === "reopenOnCategoryChange") {
    const newCategory = ASSIGNER_TRACKED_CATEGORIES.indexOf(p.newCategory) > -1 ? p.newCategory : "";
    if (ri === -1 || !newCategory) return jsonResponse({ ref: p.ref, reopened: false });

    const prevStatus   = ex(ASSIGNER_COL.STATUS);
    const prevCategory = ex(ASSIGNER_COL.CRM_STATUS);
    const reopenableFrom = prevStatus === "Rejected";
    if (!reopenableFrom) {
      return jsonResponse({ ref: p.ref, reopened: false });
    }

    // Idempotency guard — without this, the SAME reopen can refire forever.
    // The only record that a given (old row) -> newCategory transition was
    // already actioned lives in the History this action writes into the
    // brand-new Unassigned row it appends — and that row is exactly the
    // kind of thing someone might delete by hand (it's just sitting there
    // Unassigned, easy to mistake for junk/a mistake). Once deleted, the
    // NEXT poll sees this same frozen old row again, with the CRM's live
    // category still reading as newCategory (nothing about deleting the
    // child row changes what the CRM itself is showing) — so it fires
    // again, forever, recreating the exact row that was just deleted.
    // Fixed by also recording a lightweight marker directly onto THIS old
    // row's own History cell (the one thing about it that's still safe to
    // touch after the fact — Status/every timestamp/every other column
    // stays frozen, so this can't affect any historical count) the moment
    // a reopen actually happens, and checking for that marker before ever
    // reopening again. This only blocks a re-fire against this SAME frozen
    // row for this SAME target category — a later, genuinely new
    // completed/rejected cycle for this ref is a different row entirely
    // and reopens normally.
    const oldHistoryEvents = parseHistory(ex(ASSIGNER_COL.HISTORY));
    const alreadyReopenedToThis = oldHistoryEvents.some(e => e && e.type === "recategorized" && e.to === newCategory);
    if (alreadyReopenedToThis) {
      return jsonResponse({ ref: p.ref, reopened: false, alreadyReopened: true });
    }

    const prevEditor     = ex(ASSIGNER_COL.EDITOR);
    const wasDownloaded  = isTruthyCell(ex(ASSIGNER_COL.DOWNLOADED));
    // Fresh history — does NOT carry the old row's history forward (see
    // the History modal's multi-row reconstruction in assigner-content.js,
    // which now assumes each row holds only its own cycle's events; a
    // carried-forward copy here would duplicate every one of those events
    // in the merged timeline).
    let historyJson = "";

    historyJson = appendHistory(historyJson, {
      type: "recategorized", ts: now.toISOString(),
      from: prevCategory || "(uncategorized)", to: newCategory,
    });
    if (wasDownloaded) {
      historyJson = appendHistory(historyJson, {
        type: "downloaded_cleared", ts: now.toISOString(),
        reason: "Previous download is from the old shoot — cleared on reopen",
      });
    }
    historyJson = appendHistory(historyJson, {
      type: "unassigned", ts: now.toISOString(), editor: prevEditor,
      reason: "Auto-reopened — category advanced to " + newCategory + " after " + prevStatus.toLowerCase(),
    });

    // Marks the OLD row with the same "recategorized" event, so the guard
    // above can see it even after the new row below gets deleted. Written
    // to the History cell ONLY — every other column on this row (Status,
    // every *At timestamp, Editor, etc.) is left exactly as it was.
    sheet.getRange(ri, ASSIGNER_COL.HISTORY).setValue(
      appendHistory(ex(ASSIGNER_COL.HISTORY), {
        type: "recategorized", ts: now.toISOString(),
        from: prevCategory || "(uncategorized)", to: newCategory,
      })
    );

    // Append — NOT setValues on ri. The old row (still at ri) is never
    // touched by this action; this creates a second, independent row for
    // the same Ref.
    sheet.appendRow(fullRow({
      editor: "", status: "Unassigned",
      assignedAt: "", updatedAt: now, unassignedAt: now,
      startedAt: "", completedAt: "", rejectedAt: "",
      onHoldAt: "", onHoldReason: "",
      assignedBy: "", reassignedFrom: "", reassignedTo: "", reassignedBy: "", reassignedAt: "",
      crmStatus: newCategory, title: p.title || ex(ASSIGNER_COL.TITLE),
      downloaded: false, downloadedAt: "",
      history: historyJson,
    }));
    return jsonResponse({ ref: p.ref, reopened: true, category: newCategory });
  }

  // ── restartRejected ─────────────────────────────────────────────────────
  // Manual counterpart to reopenOnCategoryChange, triggered by a person
  // clicking "Restart" on a Rejected listing rather than the CRM's category
  // genuinely advancing on its own. Same "append a brand-new row, old row
  // untouched" shape (so this rework cycle is tracked as its own entry,
  // same as the automatic path) — and, like the automatic path, leaves the
  // new row Unassigned and open for anyone to pick up, tagged with
  // whichever tracked category was picked in the prompt.
  if (p.action === "restartRejected") {
    if (ri === -1) return jsonResponse({ ref: p.ref, restarted: false, error: "No existing row" });
    const prevStatus = ex(ASSIGNER_COL.STATUS);
    if (prevStatus !== "Rejected") return jsonResponse({ ref: p.ref, restarted: false, error: "Not currently Rejected" });

    const newCategory = ASSIGNER_TRACKED_CATEGORIES.indexOf(p.newCategory) > -1 ? p.newCategory : "";
    if (!newCategory) return jsonResponse({ ref: p.ref, restarted: false, error: "Missing or invalid category" });

    const prevEditor = ex(ASSIGNER_COL.EDITOR);
    // Same non-load-bearing sanity check as restartCompleted — see there.
    if (!prevEditor) return jsonResponse({ ref: p.ref, restarted: false, error: "No prior editor on file" });

    // Fresh history — no carry-forward, no "assigned" event (nothing's
    // assigned yet).
    const historyJson = appendHistory("", {
      type: "restarted", ts: now.toISOString(), by: p.actionBy || "",
      reason: "reshoot", previousEditor: prevEditor,
    });

    sheet.appendRow(fullRow({
      editor: "", status: "Unassigned",
      assignedAt: "", updatedAt: now, unassignedAt: now,
      startedAt: "", completedAt: "", rejectedAt: "",
      onHoldAt: "", onHoldReason: "",
      assignedBy: "", reassignedFrom: "", reassignedTo: "", reassignedBy: "", reassignedAt: "",
      crmStatus: newCategory,
      downloaded: false, downloadedAt: "",
      title: p.title || ex(ASSIGNER_COL.TITLE),
      history: historyJson,
    }));
    return jsonResponse({ ref: p.ref, restarted: true, category: newCategory });
  }

  // ── restartCompleted ─────────────────────────────────────────────────────
  // Restart button on a Completed listing — always available (not gated on
  // detecting the CRM category came back; see assigner-content.js). A
  // person clicking this on something already marked Completed here is, by
  // definition, saying "this needs doing again."
  //
  // Behaves the same as reopenOnCategoryChange rather than reassigning
  // straight back to the same editor: the new row goes to Unassigned,
  // open for anyone to pick up, tagged with whichever tracked category
  // the person picked in the prompt (p.newCategory) — not forced to
  // "Re-shoot" the way it used to be, since a Restart doesn't necessarily
  // mean the same rework category as before. Nothing's assigned yet, so
  // assignedAt/assignedBy are blank rather than timestamped to prevEditor.
  //
  // Same "append a brand-new row, old row completely untouched" shape as
  // before — this rework cycle is tracked as its own entry, so the
  // historical Completed count for the old row/cycle stays accurate no
  // matter how many times a listing gets reshot.
  if (p.action === "restartCompleted") {
    if (ri === -1) return jsonResponse({ ref: p.ref, restarted: false, error: "No existing row" });
    const prevStatus = ex(ASSIGNER_COL.STATUS);
    if (prevStatus !== "Completed") return jsonResponse({ ref: p.ref, restarted: false, error: "Not currently Completed" });

    const newCategory = ASSIGNER_TRACKED_CATEGORIES.indexOf(p.newCategory) > -1 ? p.newCategory : "";
    if (!newCategory) return jsonResponse({ ref: p.ref, restarted: false, error: "Missing or invalid category" });

    const prevEditor = ex(ASSIGNER_COL.EDITOR);
    // No longer load-bearing for the new row's own state (it doesn't use
    // prevEditor for anything but the audit note on the "restarted"
    // event below) — kept as a sanity check that this row was actually
    // worked before, rather than restarting something that was never
    // assigned to begin with.
    if (!prevEditor) return jsonResponse({ ref: p.ref, restarted: false, error: "No prior editor on file" });

    // Fresh history — does NOT carry the old row's history forward. Just
    // the one event marking the restart itself; there's no assignment
    // happening yet, so no "assigned" event either.
    const historyJson = appendHistory("", {
      type: "restarted", ts: now.toISOString(), by: p.actionBy || "",
      reason: "reshoot", previousEditor: prevEditor,
    });

    sheet.appendRow(fullRow({
      editor: "", status: "Unassigned",
      assignedAt: "", updatedAt: now, unassignedAt: now,
      startedAt: "", completedAt: "", rejectedAt: "",
      onHoldAt: "", onHoldReason: "",
      assignedBy: "", reassignedFrom: "", reassignedTo: "", reassignedBy: "", reassignedAt: "",
      crmStatus: newCategory,
      downloaded: false, downloadedAt: "",
      title: p.title || ex(ASSIGNER_COL.TITLE),
      history: historyJson,
    }));
    return jsonResponse({ ref: p.ref, restarted: true, category: newCategory });
  }

  // ── assign (and re-assign) ────────────────────────────────────────────
  const editor     = p.editor  || "";
  const title      = p.title   || "";
  const actionBy   = p.actionBy || "";
  const prevEditor = ex(ASSIGNER_COL.EDITOR);
  const prevStatus = ex(ASSIGNER_COL.STATUS);

  // When the round-robin auto-assigner (not a deliberate popover click)
  // is what triggered this assign, stamp AssignedBy with both facts at
  // once: that it was auto-assigned, AND whose device it ran on — so a
  // senior looking at Time History later can tell "the system did this"
  // apart from "I did this", while still knowing which tab/device fired
  // it if that ever needs chasing down (e.g. a stuck browser tab left
  // open and auto-assigning overnight).
  const assignedByLabel = p.isAutoAssign
    ? `Auto-assign (${actionBy || "unknown"})`
    : actionBy;

  // Auto-assign only, not manual: if this request is flagged as
  // machine-triggered (see the round-robin auto-assign feature) and, by
  // the time it actually gets to run under the lock above, the row has
  // already been claimed by someone/something else since this request was
  // sent, back off instead of overwriting. This is what actually closes
  // the race a client-side check alone can't: two auto-assign requests for
  // the same brand-new listing (e.g. from two different seniors' tabs,
  // each unaware of the other) both reach the server within the same
  // instant, but LockService only lets one run assignerDoPost_impl at a
  // time — so whichever request's turn comes second re-reads the sheet
  // fresh (see `data` above) and, if it sees the row is now genuinely
  // Assigned/In Progress/etc., simply reports that back instead of writing
  // a spurious "reassigned" over top of it. A manual assign/reassign from
  // the popover never sets isAutoAssign, so this never affects a senior
  // deliberately reassigning something that's already assigned — that
  // still always goes through below as normal.
  if (p.isAutoAssign && ri > -1 && isActiveAssignmentStatus(prevStatus)) {
    return jsonResponse({
      ref: p.ref, skipped: true, reason: "already assigned",
      editor: prevEditor, status: prevStatus, updatedAt: fmt(ex(ASSIGNER_COL.UPDATED_AT)),
    });
  }

  const isReAssign = !!(ri > -1 && prevEditor && prevEditor !== editor);
  // "Fresh start" = there's no real prior assignment to build on — either
  // this is a genuine reassign (different editor), or whatever's on file
  // isn't an active assignment. Deliberately checked via
  // isActiveAssignmentStatus (truthy AND not "Unassigned") rather than a
  // literal `prevStatus === "Unassigned"` — a row can reach this point
  // with a BLANK prevStatus too (e.g. syncMeta's metadata-only row-creation
  // path above pre-created a bare row with no status yet), and that's just
  // as much a fresh start as an explicit "Unassigned" is. Treating it as
  // fresh is what makes this write self-healing: AssignedAt/AssignedBy/the
  // "assigned" history entry all get properly populated here regardless of
  // whether this is the very first write to touch this ref or a follow-up
  // that lands after some other passive write already created the row.
  const isFreshStart = isReAssign || !isActiveAssignmentStatus(prevStatus);
  const newAssignedAt = isFreshStart ? now : (ex(ASSIGNER_COL.ASSIGNED_AT) || now);
  const crmStatusOverride = ASSIGNER_TRACKED_CATEGORIES.indexOf(p.crmStatus) > -1 ? p.crmStatus : "";

  let historyJson = ex(ASSIGNER_COL.HISTORY);
  if (isReAssign) {
    historyJson = appendHistory(historyJson, {
      type: "reassigned", ts: now.toISOString(), from: prevEditor, to: editor, by: actionBy,
    });
  } else if (ri === -1 || isFreshStart) {
    historyJson = appendHistory(historyJson, {
      type: "assigned", ts: now.toISOString(), editor: editor, by: assignedByLabel,
    });
  }

  if (ri > -1) {
    sheet.getRange(ri, 1, 1, ASSIGNER_HEADERS.length).setValues([fullRow({
      editor,
      title:           title || ex(ASSIGNER_COL.TITLE),
      status:          "Assigned",
      assignedAt:      newAssignedAt,
      updatedAt:       now,
      startedAt:       isFreshStart ? "" : ex(ASSIGNER_COL.STARTED_AT),
      onHoldAt:        "",
      onHoldReason:    "",
      assignedBy:      isFreshStart ? assignedByLabel : (ex(ASSIGNER_COL.ASSIGNED_BY) || assignedByLabel),
      reassignedFrom:  isReAssign ? prevEditor : ex(ASSIGNER_COL.REASSIGNED_FROM),
      reassignedTo:    isReAssign ? editor     : ex(ASSIGNER_COL.REASSIGNED_TO),
      reassignedBy:    isReAssign ? actionBy   : ex(ASSIGNER_COL.REASSIGNED_BY),
      reassignedAt:    isReAssign ? now        : ex(ASSIGNER_COL.REASSIGNED_AT),
      history:         historyJson,
      ...(crmStatusOverride ? { crmStatus: crmStatusOverride } : {}),
    })]);
  } else {
    sheet.appendRow(fullRow({ ref: p.ref, title, editor, status: "Assigned",
      assignedAt: now, updatedAt: now, assignedBy: assignedByLabel, history: historyJson,
      ...(crmStatusOverride ? { crmStatus: crmStatusOverride } : {}) }));
  }
  return jsonResponse({ ref: p.ref, title, editor, status: "Assigned",
    reAssigned: isReAssign, assignedAt: fmt(newAssignedAt),
    assignedBy:     isFreshStart ? assignedByLabel : (ex(ASSIGNER_COL.ASSIGNED_BY) || assignedByLabel),
    reassignedFrom: isReAssign ? prevEditor : ex(ASSIGNER_COL.REASSIGNED_FROM),
    reassignedTo:   isReAssign ? editor     : ex(ASSIGNER_COL.REASSIGNED_TO),
    reassignedBy:   isReAssign ? actionBy   : ex(ASSIGNER_COL.REASSIGNED_BY),
    reassignedAt:   isReAssign ? fmt(now)   : fmt(ex(ASSIGNER_COL.REASSIGNED_AT)),
    crmStatus:      crmStatusOverride || ex(ASSIGNER_COL.CRM_STATUS) });
}

// ═══════════════════════════════════════════════════════════════════════
// ARCHIVING — keeps the live Assignments tab small over time
// ═══════════════════════════════════════════════════════════════════════
// Moves Completed/Rejected rows whose CompletedAt/RejectedAt is older than
// ARCHIVE_AFTER_DAYS into the "Assignments Archive" tab in this same
// spreadsheet. Run manually once to test, then wire to a daily time-driven
// trigger (see installArchiveTrigger below).
//
// Deliberately keyed off CompletedAt/RejectedAt rather than UpdatedAt.
// UpdatedAt gets silently re-touched by syncMeta every time any open CRM
// tab passively re-confirms a listing's bedrooms/category — even for
// listings nobody is actually working on anymore, since that dedupe cache
// lives per-tab and resets on every page reload. If archiving used
// UpdatedAt, a Completed/Rejected row sitting in a still-open browser tab
// would have its "age" reset every few seconds and would never qualify for
// archiving. CompletedAt/RejectedAt are write-once (set exactly once, the
// first time that status is reached, and never touched again after) — the
// correct signal for "how long has this genuinely been finished," as
// opposed to "when did something last poke it."
//
// Safe by construction: only rows with a terminal status (Completed/
// Rejected) are ever moved — anything Assigned/In Progress/On Hold/
// Unassigned is left alone no matter how old, since those are still live
// work. History (the full audit trail) moves WITH the row, so nothing is
// lost — it's just no longer in the range the live dashboard scans.
function archiveOldAssignments() {
  const sheet = getAssignerSheet();
  const archive = getArchiveSheet();
  const values = sheet.getDataRange().getValues();
  const cutoff = new Date(Date.now() - ARCHIVE_AFTER_DAYS * 86400 * 1000);

  const rowsToArchive = [];
  const rowsToKeep = [values[0]]; // keep header

  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    const status = row[ASSIGNER_COL.STATUS - 1];

    // Pick whichever terminal timestamp actually applies to this row's
    // status — Completed rows use CompletedAt, Rejected rows use
    // RejectedAt. Both are write-once, so neither drifts from passive
    // syncMeta activity the way UpdatedAt does.
    const isCompleted = status === "Completed";
    const isRejected  = status === "Rejected";
    const terminalRaw = isCompleted
      ? row[ASSIGNER_COL.COMPLETED_AT - 1]
      : (isRejected ? row[ASSIGNER_COL.REJECTED_AT - 1] : "");
    const terminalAt = terminalRaw instanceof Date ? terminalRaw : new Date(terminalRaw);

    const isTerminal = isCompleted || isRejected;
    // If the row is terminal but somehow has no valid terminal timestamp
    // (shouldn't happen in normal operation, but data can be messy after a
    // migration), skip archiving it rather than guessing — better to leave
    // an odd row live than silently lose it to a bad date comparison.
    const isOldEnough = isTerminal && !isNaN(terminalAt.getTime()) && terminalAt < cutoff;

    if (isOldEnough) {
      rowsToArchive.push(row);
    } else {
      rowsToKeep.push(row);
    }
  }

  if (rowsToArchive.length === 0) {
    Logger.log("No rows old enough to archive.");
    return;
  }

  // Append to archive, then rewrite the live sheet with only the kept rows.
  archive.getRange(archive.getLastRow() + 1, 1, rowsToArchive.length, ASSIGNER_HEADERS.length)
    .setValues(rowsToArchive);

  sheet.clearContents();
  sheet.getRange(1, 1, rowsToKeep.length, ASSIGNER_HEADERS.length).setValues(rowsToKeep);

  Logger.log("Archived " + rowsToArchive.length + " rows. " + (rowsToKeep.length - 1) + " remain live.");
}

// Run this ONCE manually (select it in the Apps Script editor toolbar and
// click Run) to set up the daily trigger. After that, archiveOldAssignments
// runs automatically every night — no need to touch this again.
function installArchiveTrigger() {
  // Remove any existing archive triggers first so re-running this doesn't
  // create duplicates.
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === "archiveOldAssignments") ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger("archiveOldAssignments")
    .timeBased()
    .everyDays(1)
    .atHour(3) // runs ~3am, low-traffic window
    .create();
  Logger.log("Daily archive trigger installed.");
}
