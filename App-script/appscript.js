/**
 * DP Toolkit — Unified Google Apps Script
 * Combines two previously-separate backends into one script bound to one
 * spreadsheet:
 *   • DP Photo Assigner  — "Assignments" tab (Ref/Title/Editor/Status/...)
 *   • DP Listing Copier  — one tab per editor, plus Lifestyle/Amenities/Incoming
 *
 * Requests are routed by shape, not by URL path (both share one Web App
 * deployment/URL): every Assigner request always includes a `token` field
 * (its existing auth mechanism); Copier requests never do. That single
 * distinguishing field is enough to route unambiguously — see doGet/doPost
 * below.
 */

// ── Shared config ──────────────────────────────────────────────────────────
var SHEET_ID  = "19UgIXRizvOcly1UBKJuQIcKe0s4KuSEPuPUOqc5zN-8";
var CACHE_KEY = "dp_sheet_data";
var CACHE_TTL = 25; // seconds

// Real-time mode: the Assigner's read endpoint (getAssignerAssignments) is
// intentionally UNCACHED — every call does a fresh sheet read, so the
// extension's tightened ~3s poll always gets the true current state rather
// than up-to-10s-stale cached data. ASSIGNER_CACHE_KEY/TTL removed along
// with it; bustAssignerCache() below is kept as a harmless no-op so every
// existing call site still works without needing to be touched individually.

var COPIER_HEADERS = [
  "Date Uploaded",
  "DP-REQ Number",
  "Listing Reference",
  "Listing Link",
  "Location",
  "Unit / Plot No",
  "Category",
  "Beds",
  "Furnishing",
  "Photographer",
  "List Type",
  "Status",
  "Received Date",
  "Rejection Reason",
  "Agent Request Sub-type",
  "Notes",
];

var LIFESTYLE_HEADERS = ["Date", "Editor", "Lifestyle", "Profile", "Others"];
var EMAIL_CLOSED_HEADERS = ["Editor", "Subject", "Time Closed"];

// ── Unified entry points ─────────────────────────────────────────────────
function doGet(e) {
  var token = e && e.parameter ? e.parameter.token : null;
  if (token) return getAssignerAssignments(token);

  var action = (e && e.parameter && e.parameter.action) || '';
  if (action === 'getData') return getAllSheetData();
  return jsonResponse({ success: true, ping: true });
}

function doPost(e) {
  try {
    var payload = JSON.parse(e.postData.contents);

    // Assigner requests always carry a token (its auth mechanism); Copier
    // requests never do — that's the whole routing rule.
    if (payload.token !== undefined) return assignerDoPost(payload);

    if (payload.ping)                      return jsonResponse({ success: true, ping: true });
    if (payload.action === 'deleteRow')    return deleteRowFromSheet(payload);
    if (payload.action === 'updateRow')    return updateRowInSheet(payload);
    if (payload.action === 'logLifestyle') return logLifestyle(payload);
    if (payload.action === 'logEmailClosed') return logEmailClosed(payload);
    if (payload.action === 'addAmenity')   return addAmenity(payload);
    if (payload.action === 'saveIncoming') return saveIncoming(payload);

    return handleRequest(payload);
  } catch (err) {
    return jsonResponse({ success: false, error: 'Parse error: ' + err.message });
  }
}

// ── Core handler (with duplicate check) ──────────────────────────────────────

function handleRequest(payload) {
  try {
    var row        = payload.row;
    var editorName = (payload.editorName || "").trim();

    if (!row || !Array.isArray(row))
      return jsonResponse({ success: false, error: "Invalid row data." });
    if (!editorName)
      return jsonResponse({ success: false, error: "No editor name provided." });

    var ss    = SpreadsheetApp.openById(SHEET_ID);
    var sheet = getOrCreateEditorTab(ss, editorName);

    // ── Duplicate check ───────────────────────────────────────────────────────
    // Skip if this is a re-shoot (intentional re-log)
    var isReShoot = payload.reShoot === true;

    var incomingReq = String(row[1] || '').trim();
    var incomingRef = String(row[2] || '').trim();

    // Only check if we have a REQ or Reference to match on
    // Uses REQ number AND/OR Listing Reference only —
    // location is intentionally excluded because same unit can be
    // both rental (DP-R) and sale (DP-S) with identical location/unit
    if (!isReShoot && (incomingReq || incomingRef)) {
      var existing = sheet.getDataRange().getValues();
      var headers  = existing[0];
      var colReq   = headers.indexOf('DP-REQ Number');
      var colRef   = headers.indexOf('Listing Reference');

      for (var i = 1; i < existing.length; i++) {
        var existingReq = String(existing[i][colReq] || '').trim();
        var existingRef = String(existing[i][colRef] || '').trim();

        // Match on DP-REQ Number (strongest identifier)
        var reqMatch = incomingReq && existingReq && existingReq === incomingReq;
        // Match on Listing Reference (DP-R-xxxxx or DP-S-xxxxx)
        var refMatch = incomingRef && existingRef && existingRef === incomingRef;

        // Only flag duplicate if BOTH match — prevents false positives
        // when same unit has both rental and sale listings
        if (reqMatch && refMatch) {
          return jsonResponse({
            success:   false,
            duplicate: true,
            error:     'Already logged: ' + (existingReq || existingRef),
          });
        }
      }
    }
    // ─────────────────────────────────────────────────────────────────────────

    sheet.appendRow(row);
    bustCache();
    return jsonResponse({ success: true });
  } catch (err) {
    return jsonResponse({ success: false, error: err.message });
  }
}

// ── Get all data (with CacheService) ─────────────────────────────────────────

function getAllSheetData() {
  try {
    var cache  = CacheService.getScriptCache();
    var cached = cache.get(CACHE_KEY);

    if (cached) {
      // Serve from cache — instant ~100ms response
      return ContentService
        .createTextOutput(cached)
        .setMimeType(ContentService.MimeType.JSON);
    }

    // Cache miss — read from sheet (full safe read, no rows dropped)
    var ss     = SpreadsheetApp.openById(SHEET_ID);
    var sheets = ss.getSheets();
    var result = {};

    sheets.forEach(function(sheet) {
      var name    = sheet.getName();
      var lastRow = sheet.getLastRow();

      if (lastRow <= 1) { result[name] = []; return; }

      var values  = sheet.getDataRange().getValues();
      var headers = values[0];

      result[name] = values.slice(1).map(function(row, i) {
        var obj = {};
        obj['_rowIndex'] = i + 2;
        headers.forEach(function(header, j) {
          var cell = row[j];
          obj[String(header)] = (cell instanceof Date) ? cell.toISOString() : cell;
        });
        return obj;
      });
    });

    var json = JSON.stringify({ success: true, data: result });

    // Store in cache if within 95KB limit
    try {
      if (json.length < 95000) {
        cache.put(CACHE_KEY, json, CACHE_TTL);
      }
    } catch (cacheErr) {
      // Cache write failed silently — data still returned correctly
    }

    return ContentService
      .createTextOutput(json)
      .setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    return jsonResponse({ success: false, error: err.message });
  }
}

// ── Bust cache on any write/delete/update ─────────────────────────────────────

function bustCache() {
  try {
    CacheService.getScriptCache().remove(CACHE_KEY);
  } catch(e) {}
}

// No-op now that the Assigner read path is fully uncached (there's nothing
// left to invalidate) — kept in place purely so every existing call site
// at the end of a successful assignerDoPost write still works untouched.
function bustAssignerCache() {}

// ── Delete row ────────────────────────────────────────────────────────────────

function deleteRowFromSheet(payload) {
  try {
    var editorName = (payload.editorName || '').trim();
    var rowIndex   = parseInt(payload.rowIndex, 10);

    if (!editorName) return jsonResponse({ success: false, error: 'No editor name provided.' });

    var ss    = SpreadsheetApp.openById(SHEET_ID);
    var sheet = ss.getSheetByName(editorName);
    if (!sheet) return jsonResponse({ success: false, error: 'Editor tab "' + editorName + '" not found.' });

    if (rowIndex > 1 && rowIndex <= sheet.getLastRow()) {
      sheet.deleteRow(rowIndex);
      bustCache();
      return jsonResponse({ success: true });
    }

    var dpReq = String(payload.dpReqNumber     || '').trim();
    var ref   = String(payload.listingReference || '').trim();
    var loc   = String(payload.location         || '').trim();

    var values  = sheet.getDataRange().getValues();
    var headers = values[0];
    var colReq  = headers.indexOf('DP-REQ Number');
    var colRef  = headers.indexOf('Listing Reference');
    var colLoc  = headers.indexOf('Location');

    for (var i = 1; i < values.length; i++) {
      var matchReq = !dpReq || String(values[i][colReq] || '').trim() === dpReq;
      var matchRef = !ref   || String(values[i][colRef] || '').trim() === ref;
      var matchLoc = !loc   || String(values[i][colLoc] || '').trim() === loc;
      if (matchReq && matchRef && matchLoc) {
        sheet.deleteRow(i + 1);
        bustCache();
        return jsonResponse({ success: true });
      }
    }

    return jsonResponse({ success: false, error: 'Row not found — may already be deleted.' });
  } catch (err) {
    return jsonResponse({ success: false, error: err.message });
  }
}

// ── Update row ────────────────────────────────────────────────────────────────

function updateRowInSheet(payload) {
  try {
    var editorName = (payload.editorName || '').trim();
    var rowIndex   = parseInt(payload.rowIndex, 10);
    var updates    = payload.updates || {};

    if (!editorName) return jsonResponse({ success: false, error: 'No editor name provided.' });

    var ss    = SpreadsheetApp.openById(SHEET_ID);
    var sheet = ss.getSheetByName(editorName);
    if (!sheet) return jsonResponse({ success: false, error: 'Editor tab "' + editorName + '" not found.' });

    if (rowIndex < 2 || rowIndex > sheet.getLastRow())
      return jsonResponse({ success: false, error: 'Invalid row index.' });

    var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    headers.forEach(function(header, i) {
      var key = String(header);
      if (updates.hasOwnProperty(key)) {
        sheet.getRange(rowIndex, i + 1).setValue(updates[key]);
      }
    });

    bustCache();
    return jsonResponse({ success: true });
  } catch (err) {
    return jsonResponse({ success: false, error: err.message });
  }
}

// ── Lifestyle logger ──────────────────────────────────────────────────────────

function logLifestyle(payload) {
  try {
    var editorName = (payload.editorName || '').trim();
    var lifestyle  = parseInt(payload.lifestyle || 0, 10);
    var profile    = parseInt(payload.profile   || 0, 10);
    var others     = parseInt(payload.others    || 0, 10);

    if (!editorName) return jsonResponse({ success: false, error: 'No editor name provided.' });
    if (lifestyle < 0 || profile < 0 || others < 0)
      return jsonResponse({ success: false, error: 'Counts cannot be negative.' });
    if (lifestyle === 0 && profile === 0 && others === 0)
      return jsonResponse({ success: false, error: 'Please enter at least one count.' });

    var ss    = SpreadsheetApp.openById(SHEET_ID);
    var sheet = ss.getSheetByName('Lifestyle');

    if (!sheet) {
      sheet = ss.insertSheet('Lifestyle');
      sheet.appendRow(LIFESTYLE_HEADERS);
      var hr = sheet.getRange(1, 1, 1, LIFESTYLE_HEADERS.length);
      hr.setFontWeight('bold');
      hr.setBackground('#a855f7');
      hr.setFontColor('#ffffff');
      sheet.setFrozenRows(1);
      sheet.autoResizeColumns(1, LIFESTYLE_HEADERS.length);
    }

    var dateStr = new Intl.DateTimeFormat('en-US', {
      weekday:'long', year:'numeric', month:'long', day:'numeric',
    }).format(new Date());

    sheet.appendRow([dateStr, editorName, lifestyle, profile, others]);
    bustCache();
    return jsonResponse({ success: true });
  } catch (err) {
    return jsonResponse({ success: false, error: err.message });
  }
}

// ── Email Closed ──────────────────────────────────────────────────────────
// No Ref (these aren't tied to a specific listing) — just who closed it,
// what it was about, and when. Own tab, auto-created on first use.
function logEmailClosed(payload) {
  try {
    var editorName = (payload.editorName || '').trim();
    var subject    = (payload.subject    || '').trim();

    if (!editorName) return jsonResponse({ success: false, error: 'No editor name provided.' });
    if (!subject)    return jsonResponse({ success: false, error: 'Subject is required.' });

    var ss    = SpreadsheetApp.openById(SHEET_ID);
    var sheet = ss.getSheetByName('Email Closed');

    if (!sheet) {
      sheet = ss.insertSheet('Email Closed');
      sheet.appendRow(EMAIL_CLOSED_HEADERS);
      var hr = sheet.getRange(1, 1, 1, EMAIL_CLOSED_HEADERS.length);
      hr.setFontWeight('bold');
      hr.setBackground('#22d3ee');
      hr.setFontColor('#ffffff');
      sheet.setFrozenRows(1);
      sheet.autoResizeColumns(1, EMAIL_CLOSED_HEADERS.length);
    }

    // Same "long" date format background.js already uses for Date Uploaded
    // on normal log entries, plus a time — server-side so it's not subject
    // to whatever the person's local clock says.
    var dateStr = new Intl.DateTimeFormat('en-US', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
      hour: 'numeric', minute: '2-digit', hour12: true,
    }).format(new Date());

    sheet.appendRow([editorName, subject, dateStr]);
    bustCache();
    return jsonResponse({ success: true });
  } catch (err) {
    return jsonResponse({ success: false, error: err.message });
  }
}

// ── Amenities ─────────────────────────────────────────────────────────────────

function addAmenity(payload) {
  try {
    var location  = (payload.location  || '').trim();
    var driveLink = (payload.driveLink || '').trim();
    var notes     = (payload.notes     || '').trim();

    if (!location)  return jsonResponse({ success: false, error: 'Location is required.' });
    if (!driveLink) return jsonResponse({ success: false, error: 'Drive Link is required.' });

    var ss    = SpreadsheetApp.openById(SHEET_ID);
    var sheet = ss.getSheetByName('Amenities');

    if (!sheet) {
      sheet = ss.insertSheet('Amenities');
      sheet.appendRow(['Location', 'Drive Link', 'Notes']);
      var hr = sheet.getRange(1, 1, 1, 3);
      hr.setFontWeight('bold');
      hr.setBackground('#3b82f6');
      hr.setFontColor('#ffffff');
      sheet.setFrozenRows(1);
      sheet.autoResizeColumns(1, 3);
    }

    sheet.appendRow([location, driveLink, notes]);
    bustCache();
    return jsonResponse({ success: true });
  } catch (err) {
    return jsonResponse({ success: false, error: err.message });
  }
}

// ── Save/update incoming morning requests ─────────────────────────────────────

function saveIncoming(payload) {
  try {
    var data = payload.data || {};

    var ss    = SpreadsheetApp.openById(SHEET_ID);
    var sheet = ss.getSheetByName('Incoming');

    var INCOMING_HEADERS = ['Date','Photo Request','Agent Request','Brochure','Lifestyle','Profile','Others'];

    // Auto-create Incoming tab if needed
    if (!sheet) {
      sheet = ss.insertSheet('Incoming');
      sheet.appendRow(INCOMING_HEADERS);
      var hr = sheet.getRange(1, 1, 1, INCOMING_HEADERS.length);
      hr.setFontWeight('bold');
      hr.setBackground('#1e40af');
      hr.setFontColor('#ffffff');
      sheet.setFrozenRows(1);
      sheet.autoResizeColumns(1, INCOMING_HEADERS.length);
    }

    // Format today's date
    var now     = new Date();
    var dateStr = new Intl.DateTimeFormat('en-US', {
      weekday:'long', year:'numeric', month:'long', day:'numeric',
    }).format(now);

    // Build today's date key for matching (YYYY-MM-DD)
    var todayKey = now.getFullYear() + '-'
      + String(now.getMonth()+1).padStart(2,'0') + '-'
      + String(now.getDate()).padStart(2,'0');

    var newRow = [
      dateStr,
      parseInt(data['Photo Request'],10)||0,
      parseInt(data['Agent Request'],10)||0,
      parseInt(data['Brochure'],     10)||0,
      parseInt(data['Lifestyle'],    10)||0,
      parseInt(data['Profile'],      10)||0,
      parseInt(data['Others'],       10)||0,
    ];

    // Check if today already has a row — update it if so
    var values  = sheet.getDataRange().getValues();
    var updated = false;

    for (var i = 1; i < values.length; i++) {
      var cell = values[i][0]; // Date column
      var d    = (cell instanceof Date) ? cell : new Date(cell);
      if (isNaN(d)) continue;

      var key = d.getFullYear() + '-'
        + String(d.getMonth()+1).padStart(2,'0') + '-'
        + String(d.getDate()).padStart(2,'0');

      if (key === todayKey) {
        // Update existing row in place
        sheet.getRange(i + 1, 1, 1, newRow.length).setValues([newRow]);
        updated = true;
        break;
      }
    }

    if (!updated) {
      sheet.appendRow(newRow);
    }

    bustCache();
    return jsonResponse({ success: true });

  } catch (err) {
    return jsonResponse({ success: false, error: err.message });
  }
}

// ── Tab management ────────────────────────────────────────────────────────────

function getOrCreateEditorTab(ss, editorName) {
  var sheet = ss.getSheetByName(editorName);
  if (!sheet) {
    sheet = ss.insertSheet(editorName);
    sheet.appendRow(COPIER_HEADERS);
    var hr = sheet.getRange(1, 1, 1, COPIER_HEADERS.length);
    hr.setFontWeight("bold");
    hr.setBackground("#22c55e");
    hr.setFontColor("#ffffff");
    sheet.setFrozenRows(1);
    sheet.autoResizeColumns(1, COPIER_HEADERS.length);
    bustCache();
  }
  return sheet;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ═══════════════════════════════════════════════════════════════════════
// DP PHOTO ASSIGNER — "Assignments" tab
// ═══════════════════════════════════════════════════════════════════════

const ASSIGNER_TOKEN = "DPPE";
const ASSIGNER_SHEET_NAME = "Assignments";
const ASSIGNER_TRACKED_CATEGORIES = ["Offplan Pending", "Photos For QC", "Stock Photos For QC", "Upload Pending", "Re-shoot"];
const ASSIGNER_HEADERS = [
  "Ref","Title","Editor","Status",
  "AssignedAt","UpdatedAt","Downloaded","DownloadedAt",
  "CompletedAt","StartedAt","RejectedAt","OnHoldAt","OnHoldReason",
  "AssignedBy",
  "ReassignedFrom","ReassignedTo","ReassignedBy","ReassignedAt",
  "Bedrooms","Category","UnassignedAt",
  "History"
];
const ASSIGNER_COL = {
  REF:1,TITLE:2,EDITOR:3,STATUS:4,
  ASSIGNED_AT:5,UPDATED_AT:6,DOWNLOADED:7,DOWNLOADED_AT:8,
  COMPLETED_AT:9,STARTED_AT:10,REJECTED_AT:11,ON_HOLD_AT:12,ON_HOLD_REASON:13,
  ASSIGNED_BY:14,
  REASSIGNED_FROM:15,REASSIGNED_TO:16,REASSIGNED_BY:17,REASSIGNED_AT:18,
  BEDROOMS:19,CRM_STATUS:20,UNASSIGNED_AT:21,
  HISTORY:22
};

// ── Append-only event log ────────────────────────────────────────────────
// The columns above are a flat "current state" row — great for the fast
// aggregate reads the Dashboard needs, but every write to them is a full
// overwrite. That's exactly what was silently destroying time-history data:
// reassigning a listing reset AssignedAt and blanked StartedAt outright, so
// the previous editor's assign/start times were gone for good, and
// ReassignedFrom/To/By/At only ever held the *latest* reassignment.
//
// History fixes that by recording every meaningful event (assigned,
// started, completed, rejected, on-hold, reassigned, unassigned,
// downloaded) as its own immutable entry in a JSON array, alongside — not
// instead of — the flat columns. The flat columns still drive the
// Dashboard exactly as before; History exists purely so the Time History
// modal can show the *complete* timeline, including editors who no longer
// hold the listing.
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
  // Defensive cap — a Sheets cell tops out around ~50k chars; 200 events is
  // far more churn than any single listing should ever see in practice.
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
  // Auto-migrate existing sheets by appending missing header columns.
  const lastCol = sheet.getLastColumn();
  if (lastCol < ASSIGNER_HEADERS.length)
    sheet.getRange(1, lastCol+1, 1, ASSIGNER_HEADERS.length-lastCol).setValues([ASSIGNER_HEADERS.slice(lastCol)]);
  // One-time rename: earlier versions labeled this column "CrmStatus" — it's
  // really a fixed task category (Offplan/QC/Upload), locked in once set,
  // not a live CRM status. Relabel the header if the old name is found.
  if (sheet.getLastColumn() >= ASSIGNER_COL.CRM_STATUS) {
    const headerCell = sheet.getRange(1, ASSIGNER_COL.CRM_STATUS);
    if (headerCell.getValue() === "CrmStatus") headerCell.setValue("Category");
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
  // Duck-typed Date check — avoids instanceof cross-realm failures in GAS V8,
  // where dates returned by getValues() may not pass `instanceof Date` even
  // though they are valid Date objects with a working getTime() method.
  if (typeof d === "object" && typeof d.getTime === "function") {
    const t = d.getTime();
    return isNaN(t) ? "" : new Date(t).toISOString();
  }
  // Number — Google Sheets stores dates as serial numbers (days since Dec 30 1899)
  // when the locale or cell type causes getValues() to return a number instead of a Date.
  if (typeof d === "number" && !isNaN(d)) {
    const jsDate = new Date((d - 25569) * 86400 * 1000);
    return isNaN(jsDate.getTime()) ? "" : jsDate.toISOString();
  }
  // String — parse and convert (handles locale-formatted strings like "6/24/2026 17:52:01").
  if (typeof d === "string" && d.trim()) {
    const parsed = new Date(d);
    return isNaN(parsed.getTime()) ? "" : parsed.toISOString();
  }
  return "";
}

// ── GET: return all tracked assignments ──────────────────────────────────
// By far the most frequently called function in this script — every
// editor's extension now polls this every ~3s. Deliberately UNCACHED: this
// is the real-time read path, so every call does a live sheet read rather
// than risking even a few seconds of staleness from a cache layer.
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
  }))});

  return ContentService
    .createTextOutput(json)
    .setMimeType(ContentService.MimeType.JSON);
}


// ── POST: handle all write actions ───────────────────────────────────────
// Wrapped in a script-wide lock: Apps Script can and does run multiple
// doPost invocations concurrently (e.g. two requests fired moments apart
// from the extension — an assign followed immediately by a metadata sync,
// or two rapid assigns). Without a lock, two concurrent executions can each
// read the sheet before either has written, both conclude a ref's row
// doesn't exist yet, and both append — producing duplicate rows, or one
// write clobbering the other with a stale snapshot (fields silently
// reverting to blank). The lock forces every write to fully complete
// before the next one starts reading, eliminating both symptoms.
// Takes the already-parsed payload (the unified doPost() at the top of this
// file parses the request body once and routes here for anything with a
// `token` field — Assigner requests always have one, Copier requests never do).
function assignerDoPost(p) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(30000); // wait up to 30s for any other write to finish
  } catch (err) {
    return jsonResponse({ error: "Server busy, please retry" });
  }
  try {
    return assignerDoPost_impl(p);
  } finally {
    // Busted unconditionally (even on a no-op/error response) rather than
    // trying to detect success from the response shape — simpler and safer,
    // and the cost of one extra cache miss on a rare invalid request is
    // negligible next to guaranteeing a real write is never served stale.
    bustAssignerCache();
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

  // Helper: read existing cell value (column is 1-based)
  function ex(col) {
    return (ri > 0 && data[ri-1][col-1] !== undefined) ? data[ri-1][col-1] : "";
  }

  // Helper: build a complete 13-column row, carrying through any columns we
  // are not explicitly changing so no data is accidentally blanked.
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
    ];
  }

  // ── unassign ─────────────────────────────────────────────────────────
  // Row is always preserved for audit/history purposes — never deleted.
  // Editor is cleared and Status is set to the literal "Unassigned" (rather
  // than blank) so the sheet itself makes clear this listing was assigned
  // and then explicitly unassigned, as opposed to a row that was never
  // touched. UnassignedAt records when that happened; if it's later
  // reassigned, AssignedAt/AssignedBy/Reassigned* above get updated as
  // normal, so between UnassignedAt and the next AssignedAt you can see
  // exactly how long it sat unassigned and who picked it up again.
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
  // Category is write-once: once set, it's never overwritten — even if the
  // client sends a different value (e.g. a stale cache) — so a listing that
  // started as "Photos For QC" stays that way even after it moves to
  // Completed or anything else downstream.
  // Only touches Bedrooms/Category/Title/UpdatedAt — never assignment fields.
  if (p.action === "syncMeta") {
    const bedrooms  = p.bedrooms  !== undefined && p.bedrooms  !== null ? String(p.bedrooms)  : "";
    const crmStatus = ASSIGNER_TRACKED_CATEGORIES.indexOf(p.crmStatus) > -1 ? p.crmStatus : "";
    const title     = p.title || "";
    if (ri > -1) {
      const overrides = { updatedAt: now };
      if (bedrooms) overrides.bedrooms = bedrooms;
      if (crmStatus && !ex(ASSIGNER_COL.CRM_STATUS)) overrides.crmStatus = crmStatus;
      if (title) overrides.title = title;
      sheet.getRange(ri, 1, 1, ASSIGNER_HEADERS.length).setValues([fullRow(overrides)]);
    } else if (p.editor || p.status) {
      // Shouldn't normally happen (assign()/setOnHold() already create the
      // row first), but create it rather than silently drop the data if it
      // does — covers both assigned listings and unassigned-but-on-hold ones.
      sheet.appendRow(fullRow({ ref: p.ref, title, editor: p.editor || "",
        status: p.status || (p.editor ? "Assigned" : ""), updatedAt: now, bedrooms, crmStatus }));
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
    // StartedAt is write-once — preserve the original time on retries.
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
    // CompletedAt is write-once — preserve the original completion time.
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
    // RejectedAt tracks the *current* rejection cycle — write-once within
    // that cycle (so retries don't jitter it), but resets on a new cycle
    // (see reopenOnCategoryChange below) rather than freezing at whichever
    // rejection happened first. History is what preserves every rejection
    // ever, not this column.
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
  // Handles a specific real-world pattern: a listing gets Rejected or
  // Completed while its category is one of the tracked ones (agent-
  // submitted/archive photos weren't good enough, or the agent simply
  // wants updated photos of the property's current condition), a reshoot
  // gets booked, and eventually the CRM's own Status badge on that listing
  // advances to a new category — meaning genuinely new work is now
  // waiting. Without this, the listing just sits showing Rejected/
  // Completed forever, because nothing in the normal assign flow ever
  // gets triggered again on it.
  //
  // Only fires when the *current* assignment status is exactly "Rejected"
  // or "Completed", and the newly-observed category is a real change —
  // never touches a listing that's Assigned/In Progress/On Hold, and does
  // nothing if the category the client is reporting is the same one
  // already on file (e.g. a page reload re-sending the same category
  // isn't a "change").
  //
  // The listing is reset to Unassigned (open for anyone to pick up, since
  // it's effectively a brand new task now), its Category is updated to the
  // new one — overriding the normal write-once Category rule, since this
  // is a deliberate, distinct new task rather than metadata drift — and
  // Downloaded is cleared, since whatever was downloaded before this point
  // belongs to the old shoot, not the new one, and leaving it checked
  // could make someone think they already have the current photos when
  // they don't. Nothing is lost: the previous category, the downloaded
  // reset, and the unassign are all appended to History individually,
  // alongside whatever was already logged when the listing first became
  // Rejected/Completed.
  if (p.action === "reopenOnCategoryChange") {
    const newCategory = ASSIGNER_TRACKED_CATEGORIES.indexOf(p.newCategory) > -1 ? p.newCategory : "";
    if (ri === -1 || !newCategory) return jsonResponse({ ref: p.ref, reopened: false });

    const prevStatus   = ex(ASSIGNER_COL.STATUS);
    const prevCategory = ex(ASSIGNER_COL.CRM_STATUS);
    const reopenableFrom = prevStatus === "Rejected" || prevStatus === "Completed";
    if (!reopenableFrom || newCategory === prevCategory) {
      return jsonResponse({ ref: p.ref, reopened: false });
    }

    const prevEditor     = ex(ASSIGNER_COL.EDITOR);
    const wasDownloaded  = isTruthyCell(ex(ASSIGNER_COL.DOWNLOADED));
    let historyJson = ex(ASSIGNER_COL.HISTORY);

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

    sheet.getRange(ri, 1, 1, ASSIGNER_HEADERS.length).setValues([fullRow({
      editor: "", status: "Unassigned", updatedAt: now, unassignedAt: now,
      crmStatus: newCategory, title: p.title || ex(ASSIGNER_COL.TITLE),
      downloaded: false, downloadedAt: "",
      history: historyJson,
    })]);
    return jsonResponse({ ref: p.ref, reopened: true, category: newCategory });
  }

  // ── assign (and re-assign) ────────────────────────────────────────────
  // Re-assign = a different editor is being set on an already-assigned row.
  // On re-assign: refresh AssignedAt to now and clear StartedAt + OnHold fields
  // so the new editor starts with a clean slate. CompletedAt and RejectedAt are
  // always preserved for audit purposes.
  const editor     = p.editor  || "";
  const title      = p.title   || "";
  const actionBy   = p.actionBy || "";   // senior who clicked Assign / Reassign
  const prevEditor = ex(ASSIGNER_COL.EDITOR);
  const prevStatus = ex(ASSIGNER_COL.STATUS);
  const isReAssign = !!(ri > -1 && prevEditor && prevEditor !== editor);
  // A row coming back from "Unassigned" has no prevEditor (it was cleared by
  // unassign()), so isReAssign alone won't catch it — but it still needs a
  // fresh AssignedAt/StartedAt, same as a true reassign, so the sheet shows
  // when it was picked up again rather than the stale original AssignedAt.
  const isFreshStart = isReAssign || prevStatus === "Unassigned";
  const newAssignedAt = isFreshStart ? now : (ex(ASSIGNER_COL.ASSIGNED_AT) || now);
  // "Re-shoot" is a CATEGORY (like Offplan Pending / Photos For QC / Upload
  // Pending), not a workflow status — Status always stays "Assigned" here.
  // When the client detects the CRM's own listing Status was "Completed" at
  // the moment of assignment, it sends crmStatus: "Re-shoot" (validated
  // against ASSIGNER_TRACKED_CATEGORIES same as syncMeta does) so this shows up in
  // the Assignment Dashboard's category breakdown. This deliberately
  // overrides whatever category was there before — unlike syncMeta's
  // write-once behavior, since a re-shoot is a distinct, newer event worth
  // tracking on its own.
  const crmStatusOverride = ASSIGNER_TRACKED_CATEGORIES.indexOf(p.crmStatus) > -1 ? p.crmStatus : "";

  // History fix: this is what actually preserves the outgoing editor's
  // timeline. Previously AssignedAt/StartedAt below were simply overwritten
  // on reassignment with nothing recording what came before — that's why a
  // reassigned listing's Time History used to lose the original editor's
  // Assigned/Started times outright, and only ever showed the single most
  // recent reassignment. Now every assign and every reassign is appended to
  // an immutable log instead, alongside (not instead of) those columns.
  let historyJson = ex(ASSIGNER_COL.HISTORY);
  if (isReAssign) {
    historyJson = appendHistory(historyJson, {
      type: "reassigned", ts: now.toISOString(), from: prevEditor, to: editor, by: actionBy,
    });
  } else if (ri === -1 || isFreshStart) {
    // Brand-new row, or picked back up after being unassigned — either way
    // a fresh "assigned" event worth its own log entry.
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
      startedAt:       isFreshStart ? "" : ex(ASSIGNER_COL.STARTED_AT),
      onHoldAt:        "",
      onHoldReason:    "",
      // AssignedBy is write-once within a single continuous assignment —
      // but once a listing has been explicitly unassigned, picking it back
      // up again is a fresh assignment, so it's fair game to update.
      assignedBy:      isFreshStart ? actionBy : (ex(ASSIGNER_COL.ASSIGNED_BY) || actionBy),
      // Reassign columns: always overwrite so the sheet shows the latest event.
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