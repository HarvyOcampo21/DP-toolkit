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
const ASSIGNER_TRACKED_CATEGORIES = ["Offplan Pending", "Photos For QC", "Stock Photos For QC", "Upload Pending", "Re-shoot"];
// Raw CRM badge strings that are "approved" follow-on states of a tracked
// category rather than genuinely new work — see CRM_STATUS_ALIASES on the
// client (assigner-content.js) for where these get normalized for display/
// category-tracking purposes. Kept here too because reopenOnCategoryChange
// needs the *un-normalized* value to tell a real resubmission apart from a
// same-category re-poll (see that function for why).
const ASSIGNER_APPROVED_ALIASES = ["QC Approved", "Stock Photos QC Approved"];
const ASSIGNER_APPROVED_ALIAS_LOWER = ASSIGNER_APPROVED_ALIASES.map(s => s.toLowerCase());
function isApprovedAlias(raw) {
  return !!raw && ASSIGNER_APPROVED_ALIAS_LOWER.indexOf(String(raw).toLowerCase()) > -1;
}
const ASSIGNER_HEADERS = [
  "Ref","Title","Editor","Status",
  "AssignedAt","UpdatedAt","Downloaded","DownloadedAt",
  "CompletedAt","StartedAt","RejectedAt","OnHoldAt","OnHoldReason",
  "AssignedBy",
  "ReassignedFrom","ReassignedTo","ReassignedBy","ReassignedAt",
  "Bedrooms","Category","UnassignedAt",
  "History","RawStatus"
];
const ASSIGNER_COL = {
  REF:1,TITLE:2,EDITOR:3,STATUS:4,
  ASSIGNED_AT:5,UPDATED_AT:6,DOWNLOADED:7,DOWNLOADED_AT:8,
  COMPLETED_AT:9,STARTED_AT:10,REJECTED_AT:11,ON_HOLD_AT:12,ON_HOLD_REASON:13,
  ASSIGNED_BY:14,
  REASSIGNED_FROM:15,REASSIGNED_TO:16,REASSIGNED_BY:17,REASSIGNED_AT:18,
  BEDROOMS:19,CRM_STATUS:20,UNASSIGNED_AT:21,
  HISTORY:22,RAW_STATUS:23
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

function checkToken(t) { return t === ASSIGNER_TOKEN; }
function findRowIndex(data, ref) {
  for (let i = 1; i < data.length; i++) if (data[i][0] === ref) return i + 1;
  return -1;
}
function isTruthyCell(v) { return v === true || v === "TRUE" || v === "true"; }
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
  const json = JSON.stringify({ assignments: rows.filter(r => r[0]).map(r => ({
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
    rawStatus:       r[22] || "",
  }))});

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
      overrides.rawStatus      !== undefined ? overrides.rawStatus      : ex(ASSIGNER_COL.RAW_STATUS),
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
  // Passively persists bedroom count + task category (both otherwise only
  // known from the CRM page's DOM) so the Dashboard can read them back
  // without depending on the listing still being loaded on screen.
  // Category is write-once: once set, it's never overwritten.
  //
  // Real no-op short-circuit: the content script's own dedupe cache lives
  // per-tab and resets on every page reload / new tab, so in practice this
  // fires far more often than the data actually changes — every open CRM
  // tab re-confirms metadata on every poll pass regardless. Rather than
  // trust the client to only call this on real changes, the server checks
  // for itself: if bedrooms/category/title would all resolve to the exact
  // same values already on file, skip the write (and the UpdatedAt bump)
  // entirely rather than paying for a no-op setValues + lock hold. This is
  // what keeps write volume down (and UpdatedAt meaningful) regardless of
  // how many tabs are open or how often they poll.
  if (p.action === "syncMeta") {
    const bedrooms  = p.bedrooms  !== undefined && p.bedrooms  !== null ? String(p.bedrooms)  : "";
    const crmStatus = ASSIGNER_TRACKED_CATEGORIES.indexOf(p.crmStatus) > -1 ? p.crmStatus : "";
    // Unlike Category (write-once, above), RawStatus reflects whatever the
    // CRM's badge literally says right now — it's overwritten on every poll
    // so reopenOnCategoryChange always has an accurate "what did we see last
    // time" to compare against, even across page reloads/tab closes.
    const rawStatus = p.rawStatus || "";
    const title     = p.title || "";
    if (ri > -1) {
      const bedroomsChanged = !!bedrooms && bedrooms !== String(ex(ASSIGNER_COL.BEDROOMS) || "");
      const categoryChanged = !!crmStatus && !ex(ASSIGNER_COL.CRM_STATUS); // write-once
      const titleChanged    = !!title && title !== ex(ASSIGNER_COL.TITLE);
      const rawStatusChanged = !!rawStatus && rawStatus !== ex(ASSIGNER_COL.RAW_STATUS);

      if (!bedroomsChanged && !categoryChanged && !titleChanged && !rawStatusChanged) {
        return jsonResponse({ ref: p.ref, synced: true, skipped: true });
      }

      const overrides = { updatedAt: now };
      if (bedroomsChanged) overrides.bedrooms = bedrooms;
      if (categoryChanged) overrides.crmStatus = crmStatus;
      if (titleChanged) overrides.title = title;
      if (rawStatusChanged) overrides.rawStatus = rawStatus;
      sheet.getRange(ri, 1, 1, ASSIGNER_HEADERS.length).setValues([fullRow(overrides)]);
    } else if (p.editor || p.status) {
      sheet.appendRow(fullRow({ ref: p.ref, title, editor: p.editor || "",
        status: p.status || (p.editor ? "Assigned" : ""), updatedAt: now, bedrooms, crmStatus, rawStatus }));
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
  // "Changed" is NOT simply "newCategory !== the Category already on file".
  // Category is write-once (see syncMeta above): it's locked to whatever
  // task category the listing FIRST appeared under, and CRM_STATUS_ALIASES
  // on the client folds "QC Approved" back down to "Photos For QC" (same
  // for the Stock Photos variant) so it counts as that same tracked
  // category everywhere else. That's the right call almost everywhere —
  // but it means a listing that gets Rejected, has the CRM auto-approve the
  // (rejected) photos it already has, and THEN gets genuinely new photos
  // from a reshoot lands back on the exact same category string it started
  // with ("Photos For QC" -> "QC Approved" -> "Photos For QC"), which is
  // indistinguishable from "nothing happened, this is just a re-poll" if
  // Category alone is the yardstick.
  //
  // RawStatus (also above, but updated every poll rather than write-once)
  // is what actually resolves that: a real resubmission is specifically the
  // transition OUT of one of the Approved aliases back into a tracked base
  // category, and that's a strictly stronger, distinguishable signal than
  // comparing category strings. A direct jump to a different tracked
  // category entirely (e.g. Photos For QC -> Upload Pending, no Approved
  // detour) is still caught the simple way, via the Category comparison.
  if (p.action === "reopenOnCategoryChange") {
    const newCategory = ASSIGNER_TRACKED_CATEGORIES.indexOf(p.newCategory) > -1 ? p.newCategory : "";
    if (ri === -1 || !newCategory) return jsonResponse({ ref: p.ref, reopened: false });

    const prevStatus   = ex(ASSIGNER_COL.STATUS);
    const prevCategory = ex(ASSIGNER_COL.CRM_STATUS);
    const prevRawStatus = ex(ASSIGNER_COL.RAW_STATUS);
    const rawStatus      = p.rawStatus || p.newCategory || "";
    const reopenableFrom = prevStatus === "Rejected" || prevStatus === "Completed";

    const directCategoryChange = newCategory !== prevCategory;
    // Same category as before, but we can see it round-tripped through an
    // Approved alias in between — that's real new work even though the
    // category string never moved.
    const resubmittedThroughApproval = !directCategoryChange
      && isApprovedAlias(prevRawStatus) && !isApprovedAlias(rawStatus);

    if (!reopenableFrom || !(directCategoryChange || resubmittedThroughApproval)) {
      // Still worth recording the raw status even when we're not reopening
      // (e.g. this poll is the "-> QC Approved" half of the round trip) —
      // otherwise the NEXT poll, which is the one that actually matters,
      // would have nothing to compare against.
      if (rawStatus && rawStatus !== prevRawStatus) {
        sheet.getRange(ri, 1, 1, ASSIGNER_HEADERS.length).setValues([fullRow({ updatedAt: now, rawStatus })]);
      }
      return jsonResponse({ ref: p.ref, reopened: false });
    }

    const prevEditor     = ex(ASSIGNER_COL.EDITOR);
    const wasDownloaded  = isTruthyCell(ex(ASSIGNER_COL.DOWNLOADED));
    let historyJson = ex(ASSIGNER_COL.HISTORY);

    historyJson = appendHistory(historyJson, {
      type: "recategorized", ts: now.toISOString(),
      from: prevCategory || "(uncategorized)", to: newCategory,
      viaApproval: resubmittedThroughApproval || undefined,
    });
    if (wasDownloaded) {
      historyJson = appendHistory(historyJson, {
        type: "downloaded_cleared", ts: now.toISOString(),
        reason: "Previous download is from the old shoot — cleared on reopen",
      });
    }
    historyJson = appendHistory(historyJson, {
      type: "unassigned", ts: now.toISOString(), editor: prevEditor,
      reason: resubmittedThroughApproval
        ? "Auto-reopened — new " + newCategory + " submission detected after " + prevStatus.toLowerCase() + " photos were approved"
        : "Auto-reopened — category advanced to " + newCategory + " after " + prevStatus.toLowerCase(),
    });

    sheet.getRange(ri, 1, 1, ASSIGNER_HEADERS.length).setValues([fullRow({
      editor: "", status: "Unassigned", updatedAt: now, unassignedAt: now,
      crmStatus: newCategory, rawStatus, title: p.title || ex(ASSIGNER_COL.TITLE),
      downloaded: false, downloadedAt: "",
      history: historyJson,
    })]);
    return jsonResponse({ ref: p.ref, reopened: true, category: newCategory });
  }

  // ── assign (and re-assign) ────────────────────────────────────────────
  const editor     = p.editor  || "";
  const title      = p.title   || "";
  const actionBy   = p.actionBy || "";
  const prevEditor = ex(ASSIGNER_COL.EDITOR);
  const prevStatus = ex(ASSIGNER_COL.STATUS);
  const isReAssign = !!(ri > -1 && prevEditor && prevEditor !== editor);
  const isFreshStart = prevStatus === "Unassigned";
  const shouldResetStarted = isFreshStart || isReAssign;
  const newAssignedAt = isFreshStart ? now : (ex(ASSIGNER_COL.ASSIGNED_AT) || now);
  const crmStatusOverride = ASSIGNER_TRACKED_CATEGORIES.indexOf(p.crmStatus) > -1 ? p.crmStatus : "";

  let historyJson = ex(ASSIGNER_COL.HISTORY);
  if (isReAssign) {
    historyJson = appendHistory(historyJson, {
      type: "reassigned", ts: now.toISOString(), from: prevEditor, to: editor, by: actionBy,
    });
  } else if (ri === -1 || isFreshStart) {
    historyJson = appendHistory(historyJson, {
      type: "assigned", ts: now.toISOString(), editor: editor, by: actionBy,
    });
  }

  if (ri > -1) {
    sheet.getRange(ri, 1, 1, ASSIGNER_HEADERS.length).setValues([fullRow({
      editor,
      title:           title || ex(ASSIGNER_COL.TITLE),
      status:          "Assigned",
      assignedAt:      newAssignedAt,
      updatedAt:       now,
      startedAt:       shouldResetStarted ? "" : ex(ASSIGNER_COL.STARTED_AT),
      onHoldAt:        "",
      onHoldReason:    "",
      assignedBy:      isFreshStart ? actionBy : (ex(ASSIGNER_COL.ASSIGNED_BY) || actionBy),
      reassignedFrom:  isReAssign ? prevEditor : ex(ASSIGNER_COL.REASSIGNED_FROM),
      reassignedTo:    isReAssign ? editor     : ex(ASSIGNER_COL.REASSIGNED_TO),
      reassignedBy:    isReAssign ? actionBy   : ex(ASSIGNER_COL.REASSIGNED_BY),
      reassignedAt:    isReAssign ? now        : ex(ASSIGNER_COL.REASSIGNED_AT),
      history:         historyJson,
      ...(crmStatusOverride ? { crmStatus: crmStatusOverride } : {}),
    })]);
  } else {
    sheet.appendRow(fullRow({ ref: p.ref, title, editor, status: "Assigned",
      assignedAt: now, updatedAt: now, assignedBy: actionBy, history: historyJson,
      ...(crmStatusOverride ? { crmStatus: crmStatusOverride } : {}) }));
  }
  return jsonResponse({ ref: p.ref, title, editor, status: "Assigned",
    reAssigned: isReAssign, assignedAt: fmt(newAssignedAt),
    assignedBy:     isFreshStart ? actionBy : (ex(ASSIGNER_COL.ASSIGNED_BY) || actionBy),
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
