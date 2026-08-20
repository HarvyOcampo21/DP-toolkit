/**
 * DP Listing Copier — Google Apps Script (Copier-only)
 *
 * Formerly combined with DP Photo Assigner in one script. Assigner logic
 * (the "Assignments" tab, its own token-based auth, and all its
 * assign/complete/reject/etc. write actions) has been split out to its own
 * dedicated Apps Script project + spreadsheet for speed/isolation reasons —
 * see the standalone Assigner script. Nothing Assigner-related remains
 * here; every request this script receives is a Copier request.
 *
 *   • DP Listing Copier — one tab per editor, plus Lifestyle/Amenities/Incoming
 *   • Also serves the Dashboard's `?action=getData` endpoint, which reads
 *     every tab in this spreadsheet EXCEPT Assignments (that tab no longer
 *     lives here at all).
 */

// ── Shared config ──────────────────────────────────────────────────────────
var SHEET_ID  = "19UgIXRizvOcly1UBKJuQIcKe0s4KuSEPuPUOqc5zN-8";
var CACHE_KEY = "dp_sheet_data";
var CACHE_TTL = 25; // seconds

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
  "Agent Name",
];

var LIFESTYLE_HEADERS = ["Date", "Editor", "Lifestyle", "Profile", "Others"];
var EMAIL_CLOSED_HEADERS = ["Editor", "Subject", "Time Closed"];

// ── Entry points ────────────────────────────────────────────────────────
// No more shape-based routing needed — every request here is Copier.
function doGet(e) {
  var action = (e && e.parameter && e.parameter.action) || '';
  if (action === 'getData') return getAllSheetData();
  return jsonResponse({ success: true, ping: true });
}

function doPost(e) {
  try {
    var payload = JSON.parse(e.postData.contents);

    if (payload.ping)                        return jsonResponse({ success: true, ping: true });
    if (payload.action === 'deleteRow')      return deleteRowFromSheet(payload);
    if (payload.action === 'updateRow')      return updateRowInSheet(payload);
    if (payload.action === 'logLifestyle')   return logLifestyle(payload);
    if (payload.action === 'logEmailClosed') return logEmailClosed(payload);
    if (payload.action === 'addAmenity')     return addAmenity(payload);
    if (payload.action === 'saveIncoming')   return saveIncoming(payload);

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
// Reads every tab in this spreadsheet. Since Assignments no longer lives
// here, there's nothing to explicitly exclude anymore — every sheet this
// loop finds is genuinely Copier data (editor tabs, Lifestyle, Amenities,
// Incoming, Email Closed).

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