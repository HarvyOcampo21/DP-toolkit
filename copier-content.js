(function () {
  "use strict";

  const DP_HOOK_KEY = "dp_complete_hook_enabled";

function isHookEnabled() {
  const saved = localStorage.getItem(DP_HOOK_KEY);
  return saved === null ? true : saved === "true"; // default ON
}

function setHookEnabled(val) {
  localStorage.setItem(DP_HOOK_KEY, val ? "true" : "false");
}

  /* =======================
     EXIT BUTTON (Escape)
  ======================= */
  document.addEventListener("keydown", function (e) {
    if (e.key !== "Escape") return;
    const closeBtn = document.querySelector(
      "button.button.is-solid.is-button-icon.preview-close-button",
    );
    if (closeBtn) closeBtn.click();
  });

  /* =======================
     SEARCH BUTTON (Enter)
  ======================= */
  document.addEventListener("keydown", function (e) {
    if (e.key !== "Enter") return;
    const enterBtn = document.querySelector(
      "button.button.ml-auto.search__button__HL",
    );
    if (enterBtn) enterBtn.click();
  });

  /* =======================
     KEYBOARD SHORTCUT (Alt+C → Copy Listing Info)
  ======================= */
  document.addEventListener("keydown", function (e) {
    if (e.altKey && e.key === "c") copyListingInfo();
  });

  /* =======================
     PAGE GUARD
  ======================= */
  function isSingleRequestPage() {
    const hashMatch = /^#Request#.+/.test(location.hash);
    const panelOpen = !!document.querySelector("button.preview-close-button");
    return hashMatch || panelOpen;
  }

  /* =======================
     THEME HELPERS
  ======================= */
  function isSiteDarkMode() {
    return (
      document.documentElement.classList.contains("dark") ||
      document.body.classList.contains("dark") ||
      document.querySelector(".theme-toggle input")?.checked === true
    );
  }

  function getReferenceButton() {
    return (
      document.querySelector("button.button.is-outline") ||
      document.querySelector("button.button") ||
      document.querySelector("button")
    );
  }

  function getExactButtonColors() {
    const ref = getReferenceButton();
    const dark = isSiteDarkMode();

    if (!ref) {
      return dark
        ? {
            bg: "#202c33",
            border: "#6b7280",
            text: "#cbd5e1",
            toastBg: "#1e293b",
            toastText: "#e5e7eb",
          }
        : {
            bg: "#ffffff",
            border: "#d1d5db",
            text: "#1f2937",
            toastBg: "#aeecb0",
            toastText: "#1f2937",
          };
    }

    const styles = getComputedStyle(ref);
    return {
      bg: styles.backgroundColor,
      border: styles.borderColor,
      text: styles.color,
      toastBg: dark ? "#1e293b" : "#aeecb0",
      toastText: dark ? "#e5e7eb" : "#1f2937",
    };
  }

  /* =======================
     DATA HELPERS
  ======================= */
  function getScopedContainer() {
    return (
      document.querySelector(".listing-detail, main, #app, .request-detail") ||
      document.body
    );
  }

  // ⚠️ CRITICAL — do NOT modify these regex patterns
  function getExactText(regex) {
    const container = getScopedContainer();
    return (
      [...container.querySelectorAll("span, div")]
        .filter((el) => el.children.length === 0)
        .map((el) => el.textContent.trim())
        .find((text) => regex.test(text)) || ""
    );
  }

  function getAllLocations() {
    const metaBlocks = [...document.querySelectorAll(".meta.is-flex")];
    const locations = [];

    for (const block of metaBlocks) {
      const loc =
        block.dataset.tooltip?.trim() ||
        block.textContent.replace(/\s+/g, " ").trim();

      if (loc && !/Beds|Baths|Furnishing/i.test(loc)) {
        locations.push(loc);
      }

      if (locations.length >= 2) break;
    }

    return locations.join("_");
  }

  function getSecondLocationOnly() {
    const el = document.querySelector(
      "div.meta.is-flex.is-align-items-center[data-tooltip] span",
    );
    return el ? el.innerText.trim() : "";
  }

  function getUnitPlotNumber() {
    const container = getScopedContainer();
    const text = (container.innerText || "")
      .replace(/\s+/g, " ")
      .slice(0, 5000);

    const STOP_WORDS =
      "Location|Published|Beds|Baths|Furnishing|Pending|Approved|Scheduled|Hold|Completed|Rejected";

    const patterns = [
      new RegExp(
        `Unit\\s*\\/\\s*Plot\\s*(?:No\\.?\\s*)?[:\\-]?\\s*([^\\n]+?)(?=\\s(?:${STOP_WORDS})|$)`,
        "i",
      ),
      new RegExp(
        `Office\\s*[:\\-]?\\s*([^\\n]+?)(?=\\s(?:${STOP_WORDS})|$)`,
        "i",
      ),
      new RegExp(
        `Unit\\s*(?:No\\.?\\s*)?[:\\-]?\\s*([^\\n]+?)(?=\\s(?:${STOP_WORDS})|$)`,
        "i",
      ),
      new RegExp(
        `Plot\\s*(?:No\\.?\\s*)?[:\\-]?\\s*([^\\n]+?)(?=\\s(?:${STOP_WORDS})|$)`,
        "i",
      ),
    ];

    for (const p of patterns) {
      const m = text.match(p);
      if (m) return m[1].replace(/^No\s+/i, "").trim();
    }

    return "";
  }

  function formatLongDate(dateStr) {
    if (!dateStr) return "";
    const date = new Date(dateStr);
    return new Intl.DateTimeFormat("en-US", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    }).format(date);
  }

  /* =======================
     SIDEBAR FIELD EXTRACTOR
  ======================= */
  function getSidebarValue(labelText) {
    const items = document.querySelectorAll('[data-v-8e28dde2][class*="item"]');
    for (const item of items) {
      const label = item.querySelector("label[data-v-8e28dde2]");
      if (
        label &&
        label.textContent.trim().toLowerCase() === labelText.toLowerCase()
      ) {
        const span = item.querySelector("span[data-v-8e28dde2]");
        if (span)
          return span.getAttribute("data-tooltip") || span.textContent.trim();
      }
    }

    const allItems = document.querySelectorAll('[class*="item"]');
    for (const item of allItems) {
      const labels = item.querySelectorAll("label");
      for (const label of labels) {
        if (
          label.textContent.trim().toLowerCase() === labelText.toLowerCase()
        ) {
          const span = item.querySelector("span");
          if (span)
            return span.getAttribute("data-tooltip") || span.textContent.trim();
        }
      }
    }

    return "";
  }

  /* =======================
     PHOTOGRAPHER EXTRACTOR
  ======================= */
  function getPhotographer() {
    const sel = document.querySelector('select[id*="photographer"]');
    if (sel) {
      const opt = sel.options[sel.selectedIndex];
      const name = opt ? opt.textContent.trim() : "";
      if (name && name !== "—" && name !== "-" && opt.value) return name;
    }

    const container = getScopedContainer();
    const photographerLabels = [
      ...container.querySelectorAll("label, span, p"),
    ].filter(
      (el) =>
        el.children.length === 0 &&
        /^Photographer$/i.test(el.textContent.trim()),
    );

    for (const labelEl of photographerLabels) {
      let parent = labelEl.parentElement;
      for (let i = 0; i < 5; i++) {
        if (!parent) break;
        const candidates = [
          ...parent.querySelectorAll("p, span, strong, b, h5, h6"),
        ].filter(
          (el) =>
            el.children.length === 0 &&
            el.textContent.trim() &&
            !/^Photographer$/i.test(el.textContent.trim()) &&
            !/^Photo(graph)?$/i.test(el.textContent.trim()) &&
            !/^3D\s*Tour$/i.test(el.textContent.trim()) &&
            !/^Request\s*for$/i.test(el.textContent.trim()) &&
            !/^No\s+Photo/i.test(el.textContent.trim()),
        );
        if (candidates.length > 0) return candidates[0].textContent.trim();
        parent = parent.parentElement;
      }
    }

    return "";
  }

  /* =======================
     GATHER ALL DATA
  ======================= */
  function gatherAllData() {
    return {
      reqNumber: getExactText(/^DP-REQ-\d+/), // ⚠️ critical — do not modify
      listingRef: getExactText(/^(DP|CBB|DPA)-(S|R)-\d+/), // ⚠️ critical — do not modify
      listingLink: window.location.href,
      location: getAllLocations(),
      unitPlot: getUnitPlotNumber(),
      category: getSidebarValue("Category"),
      beds: getSidebarValue("Beds"),
      furnishing: getSidebarValue("Furnishing"),
      photographer: getPhotographer(),
    };
  }

  /* =======================
     SEARCH ACTION
  ======================= */
  async function searchWithSubLocation() {
    const location = getSecondLocationOnly();
    if (!location) {
      showToast("⚠️ No sub-location found on this page.", true);
      return;
    }

    const encodedLocation = encodeURIComponent(location);

    try {
      await navigator.clipboard.writeText(location);
    } catch (err) {
      console.log("[DP Listing Copier] Clipboard write failed:", err);
    }

    const dldUrl = `https://dubailand.gov.ae/en/eservices/real-estate-project-status-landing/real-estate-project-status/#/?search=${encodedLocation}`;
    const pfUrl = `https://www.propertyfinder.ae/en/search?c=1&fu=0&ob=mr&q=${encodedLocation}`;
    const googleUrl = `https://www.google.com/search?q=${encodedLocation}+brochure+pdf`;

    showToast(`🔍 Opening 3 tabs for:\n${location}`);
    window.open(dldUrl, "_blank");
    window.open(pfUrl, "_blank");
    window.open(googleUrl, "_blank");
  }

  /* =======================
     CORE ACTIONS
  ======================= */
  function copyListingInfo() {
    const result = [
      getExactText(/^(DP|CBB|DPA)-(S|R)-\d+/), // ⚠️ critical — do not modify
      getAllLocations(),
      getUnitPlotNumber(),
    ]
      .filter(Boolean)
      .join("_");

    if (!result) {
      showToast("⚠️ No listing info found on this page.", true);
      return;
    }

    navigator.clipboard
      .writeText(result)
      .then(() => showToast("✅ Copied:\n" + result));
  }

  function copySecondLocation() {
    const text = getSecondLocationOnly();
    if (!text) {
      showToast("⚠️ No sub-location found on this page.", true);
      return;
    }
    navigator.clipboard
      .writeText(text)
      .then(() => showToast("✅ Copied:\n" + text));
  }

  /* =======================
     LOG TO SHEET MODAL
  ======================= */
  function openLogModal(presets) {
    if (document.getElementById("dp-log-modal")) return;
    chrome.storage.local.get(["myName"], ({ myName: editorName }) => {
      _buildLogModal(editorName || "", presets || null);
    });
  }

  function _buildLogModal(editorName, presets) {
    if (document.getElementById("dp-log-modal")) return;

    const data = gatherAllData();
    const dark = isSiteDarkMode();
    const hasPhotographer = !!data.photographer;
    const noEditor = !editorName;

    const modalBg = dark ? "#1e293b" : "#ffffff";
    const modalText = dark ? "#e5e7eb" : "#1f2937";
    const borderCol = dark ? "#334155" : "#e5e7eb";
    const inputBg = dark ? "#0f172a" : "#f9fafb";
    const labelCol = dark ? "#94a3b8" : "#6b7280";
    const accentCol = "#22c55e";

    const overlay = document.createElement("div");
    overlay.id = "dp-log-modal";
    overlay.innerHTML = `
      <div id="dp-log-backdrop" style="
        position:fixed; inset:0; background:rgba(0,0,0,0.6);
        z-index:99999; display:flex; align-items:center; justify-content:center;
        backdrop-filter:blur(4px); font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
      ">
        <div style="
          background:${modalBg}; color:${modalText}; border-radius:14px;
          padding:26px 28px; width:460px; max-width:95vw; max-height:90vh;
          overflow-y:auto; box-shadow:0 24px 64px rgba(0,0,0,0.45);
          border:1px solid ${borderCol};
        ">

          <!-- Header -->
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:16px;">
            <div>
              <h2 style="margin:0; font-size:15px; font-weight:700; letter-spacing:-.01em;">
                📋 Log to Google Sheet
              </h2>
              <p style="margin:3px 0 0; font-size:11px; color:${noEditor ? "#ef4444" : accentCol}; font-weight:600;">
                ${
                  noEditor
                    ? "⚠️ No editor selected — open the extension popup first"
                    : `Logging as: ${editorName} → tab &quot;${editorName}&quot;`
                }
              </p>
            </div>
            <button id="dp-modal-close" style="
              background:none; border:none; color:${labelCol}; font-size:22px;
              cursor:pointer; padding:0 2px; line-height:1; font-weight:300;
            ">×</button>
          </div>

          <!-- Data preview card -->
          <div style="
            background:${inputBg}; border-radius:9px; padding:14px 16px;
            margin-bottom:18px; border:1px solid ${borderCol};
            font-size:13px; line-height:2;
          ">
            ${modalRow("REQ #", data.reqNumber, labelCol)}
            ${modalRow("Listing Ref", data.listingRef, labelCol)}
            ${modalRow("Location", data.location, labelCol)}
            ${modalRow("Unit / Plot", data.unitPlot, labelCol)}
            ${modalRow("Category", data.category, labelCol)}
            ${modalRow("Beds", data.beds, labelCol)}
            ${modalRow("Furnishing", data.furnishing, labelCol)}
            ${modalRow("Photographer", data.photographer || "—", labelCol)}
          </div>

          <!-- Re-shoot toggle -->
          <div style="margin-bottom:14px;">
            <label style="
              display:block; font-size:11px; font-weight:700; color:${labelCol};
              margin-bottom:8px; text-transform:uppercase; letter-spacing:.07em;
            ">Entry Type</label>
            <div style="display:flex; gap:8px;">
              <label style="
                flex:1; display:flex; align-items:center; gap:8px;
                padding:9px 12px; border-radius:8px; cursor:pointer;
                border:1px solid ${borderCol}; background:${inputBg};
                transition: all .15s;
              " id="dp-normal-label">
                <input type="radio" name="dp-entry-type" id="dp-entry-normal" value="normal" checked
                  style="accent-color:#22c55e; width:15px; height:15px;">
                <span style="font-size:13px; color:${modalText};">Normal Log</span>
              </label>
              <label style="
                flex:1; display:flex; align-items:center; gap:8px;
                padding:9px 12px; border-radius:8px; cursor:pointer;
                border:1px solid ${borderCol}; background:${inputBg};
                transition: all .15s;
              " id="dp-reshoot-label">
                <input type="radio" name="dp-entry-type" id="dp-entry-reshoot" value="reshoot"
                  style="accent-color:#f97316; width:15px; height:15px;">
                <span style="font-size:13px; color:${modalText};">📸 Re-shoot</span>
              </label>
            </div>
            <p id="dp-reshoot-hint" style="margin:6px 0 0; font-size:11px; color:${labelCol}; display:none;">
              Re-shoot bypasses duplicate check and pre-fills Notes with "Re-shoot".
            </p>
          </div>

          <!-- Photographer (re-shoot only) -->
          <div id="dp-reshoot-photographer-wrapper" style="margin-bottom:14px; display:none;">
            <label style="
              display:block; font-size:11px; font-weight:700; color:${labelCol};
              margin-bottom:6px; text-transform:uppercase; letter-spacing:.07em;
            ">Photographer</label>
            <input id="dp-reshoot-photographer" type="text" placeholder="Photographer name"
              value="${(data.photographer || "").replace(/"/g, "&quot;")}"
              style="
                width:100%; padding:9px 12px; border-radius:8px;
                border:1px solid ${borderCol}; background:${inputBg};
                color:${modalText}; font-size:14px; outline:none;
              ">
            <p style="margin:5px 0 0; font-size:11px; color:${labelCol};">
              Who's doing the re-shoot? Logged as the Photographer for this entry.
            </p>
          </div>

          <!-- Status -->
          <div style="margin-bottom:14px;">
            <label style="
              display:block; font-size:11px; font-weight:700; color:${labelCol};
              margin-bottom:6px; text-transform:uppercase; letter-spacing:.07em;
            ">Status</label>
            <select id="dp-status-select" style="
              width:100%; padding:9px 12px; border-radius:8px;
              border:1px solid ${borderCol}; background:${inputBg};
              color:${modalText}; font-size:14px; outline:none; cursor:pointer;
            ">
              <option value="Uploaded">Uploaded</option>
              <option value="Pending">Pending</option>
              <option value="Rejected">Rejected</option>
              <option value="No NOC">No NOC</option>
            </select>
          </div>

          <!-- Received Date -->
          <div style="margin-bottom:14px;">
            <label style="
              display:block; font-size:11px; font-weight:700; color:${labelCol};
              margin-bottom:6px; text-transform:uppercase; letter-spacing:.07em;
            ">Received Date</label>
            <input id="dp-received-date" type="date" style="
              width:100%; padding:9px 12px; border-radius:8px;
              border:1px solid ${borderCol}; background:${inputBg};
              color:${modalText}; font-size:14px; outline:none; cursor:pointer;
            ">
          </div>

          <!-- Rejection Reason (shown when Rejected or No NOC) -->
          <div id="dp-rejection-wrapper" style="margin-bottom:14px; display:none;">
            <label style="
              display:block; font-size:11px; font-weight:700; color:${labelCol};
              margin-bottom:6px; text-transform:uppercase; letter-spacing:.07em;
            ">Rejection Reason</label>
            <textarea id="dp-rejection-reason" rows="3" placeholder="Enter reason..."
              style="
                width:100%; padding:9px 12px; border-radius:8px;
                border:1px solid ${borderCol}; background:${inputBg};
                color:${modalText}; font-size:14px; outline:none; resize:vertical;
              "></textarea>
          </div>

          <!-- List Type -->
          <div style="margin-bottom:${hasPhotographer ? "14px" : "10px"};">
            <label style="
              display:block; font-size:11px; font-weight:700; color:${labelCol};
              margin-bottom:6px; text-transform:uppercase; letter-spacing:.07em;
            ">List Type</label>
            <select id="dp-listtype-select" style="
              width:100%; padding:9px 12px; border-radius:8px;
              border:1px solid ${borderCol}; background:${inputBg};
              color:${modalText}; font-size:14px; outline:none;
              ${hasPhotographer ? "opacity:0.5; pointer-events:none;" : "cursor:pointer;"}
            ">
              ${
                hasPhotographer
                  ? `<option value="Photo Request">Photo Request</option>`
                  : `<option value="Brochure">Brochure</option>
                     <option value="Agent Request">Agent Request</option>`
              }
            </select>
            <p id="dp-listtype-hint" style="margin:5px 0 0; font-size:11px; color:${labelCol};">
              ${
                hasPhotographer
                  ? `Auto-set to <strong>Photo Request</strong> — photographer assigned.`
                  : `No photographer — select Brochure or Agent Request.`
              }
            </p>
          </div>

          <!-- Agent Request Sub-type -->
          <div id="dp-subtype-wrapper" style="margin-bottom:14px; display:none;">
            <label style="
              display:block; font-size:11px; font-weight:700; color:${labelCol};
              margin-bottom:6px; text-transform:uppercase; letter-spacing:.07em;
            ">Agent Request Type</label>
            <select id="dp-subtype-select" style="
              width:100%; padding:9px 12px; border-radius:8px;
              border:1px solid ${borderCol}; background:${inputBg};
              color:${modalText}; font-size:14px; outline:none; cursor:pointer;
            ">
              <option value="Use my own photos">Use my own photos</option>
              <option value="Stock photos">Stock photos</option>
              <option value="Similar layout">Similar layout</option>
              <option value="Others">Others</option>
            </select>
          </div>

          <!-- ✅ Notes -->
          <div style="margin-bottom:22px;">
            <label style="
              display:block; font-size:11px; font-weight:700; color:${labelCol};
              margin-bottom:6px; text-transform:uppercase; letter-spacing:.07em;
            ">Notes <span style="font-weight:400;text-transform:none;letter-spacing:0;">(optional)</span></label>
            <textarea id="dp-notes" rows="3" placeholder="Any additional notes about this listing…"
              style="
                width:100%; padding:9px 12px; border-radius:8px;
                border:1px solid ${borderCol}; background:${inputBg};
                color:${modalText}; font-size:14px; outline:none; resize:vertical;
              "></textarea>
          </div>

          <!-- Action buttons -->
          <div style="display:flex; gap:10px;">
            <button id="dp-modal-submit" style="
              flex:1; padding:11px 0; background:${noEditor ? "#64748b" : accentCol}; color:#fff;
              border:none; border-radius:8px; font-size:14px; font-weight:700;
              cursor:${noEditor ? "not-allowed" : "pointer"}; transition:opacity .15s;
              ${noEditor ? "opacity:0.5;" : ""}
            ">✅ Log to Sheet</button>
            <button id="dp-modal-cancel" style="
              padding:11px 18px; background:${inputBg}; color:${modalText};
              border:1px solid ${borderCol}; border-radius:8px; font-size:14px;
              font-weight:600; cursor:pointer; transition:opacity .15s;
            ">Cancel</button>
          </div>

        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    // Set today's date as default
    const today = new Date().toISOString().split("T")[0];
    const dateInput = document.getElementById("dp-received-date");
    if (dateInput) dateInput.value = today;

    // Re-shoot toggle behavior
    const normalRadio = document.getElementById("dp-entry-normal");
    const reshootRadio = document.getElementById("dp-entry-reshoot");
    const reshootHint = document.getElementById("dp-reshoot-hint");
    const reshootLabel = document.getElementById("dp-reshoot-label");
    const normalLabel = document.getElementById("dp-normal-label");
    const notesField = document.getElementById("dp-notes");
    const listTypeSelect = document.getElementById("dp-listtype-select");
    const listTypeHint = document.getElementById("dp-listtype-hint");
    const subTypeWrapper = document.getElementById("dp-subtype-wrapper");
    const reshootPhotographerWrapper = document.getElementById("dp-reshoot-photographer-wrapper");

    // Remember the List Type select's pre-re-shoot options/lock state so we
    // can restore it exactly if Re-shoot gets unchecked again.
    const listTypeOriginalHTML = listTypeSelect ? listTypeSelect.innerHTML : "";
    const listTypeOriginalHint = listTypeHint ? listTypeHint.innerHTML : "";

    function applyReshootListTypeLock(isReshoot) {
      if (!listTypeSelect) return;
      if (isReshoot) {
        if (![...listTypeSelect.options].some((o) => o.value === "Photo Request")) {
          const opt = document.createElement("option");
          opt.value = "Photo Request";
          opt.textContent = "Photo Request";
          listTypeSelect.appendChild(opt);
        }
        listTypeSelect.value = "Photo Request";
        listTypeSelect.style.opacity = "0.5";
        listTypeSelect.style.pointerEvents = "none";
        if (subTypeWrapper) subTypeWrapper.style.display = "none";
        if (listTypeHint) {
          listTypeHint.innerHTML = `Auto-set to <strong>Photo Request</strong> — Re-shoot.`;
        }
      } else {
        listTypeSelect.innerHTML = listTypeOriginalHTML;
        listTypeSelect.style.opacity = hasPhotographer ? "0.5" : "1";
        listTypeSelect.style.pointerEvents = hasPhotographer ? "none" : "auto";
        if (listTypeHint) listTypeHint.innerHTML = listTypeOriginalHint;
      }
    }

    [normalRadio, reshootRadio].forEach((radio) => {
      radio.addEventListener("change", () => {
        const isReshoot = reshootRadio.checked;
        reshootHint.style.display = isReshoot ? "block" : "none";
        reshootLabel.style.borderColor = isReshoot ? "#f97316" : borderCol;
        reshootLabel.style.background = isReshoot
          ? "rgba(249,115,22,.1)"
          : inputBg;
        normalLabel.style.borderColor = isReshoot ? borderCol : "#22c55e";
        normalLabel.style.background = isReshoot
          ? inputBg
          : "rgba(34,197,94,.08)";
        // Pre-fill notes with Re-shoot if empty
        if (isReshoot && notesField && !notesField.value.trim()) {
          notesField.value = "Re-shoot";
        }
        if (!isReshoot && notesField && notesField.value === "Re-shoot") {
          notesField.value = "";
        }
        applyReshootListTypeLock(isReshoot);
        if (reshootPhotographerWrapper) {
          reshootPhotographerWrapper.style.display = isReshoot ? "block" : "none";
        }
      });
    });

    // Show/hide sub-type dropdown
    if (listTypeSelect && !hasPhotographer) {
      listTypeSelect.addEventListener("change", () => {
        subTypeWrapper.style.display =
          listTypeSelect.value === "Agent Request" ? "block" : "none";
      });
    }

    // Show/hide rejection reason (Rejected OR No NOC)
    const statusSelect = document.getElementById("dp-status-select");
    const rejectionWrapper = document.getElementById("dp-rejection-wrapper");
    if (statusSelect) {
      statusSelect.addEventListener("change", () => {
        const v = statusSelect.value;
        rejectionWrapper.style.display =
          v === "Rejected" || v === "No NOC" ? "block" : "none";
      });
    }

    // Apply presets (e.g. from Reject button hook) — force values + matching UI state
    if (presets) {
      if (presets.status && statusSelect) {
        statusSelect.value = presets.status;
        if (rejectionWrapper) {
          rejectionWrapper.style.display =
            presets.status === "Rejected" || presets.status === "No NOC"
              ? "block"
              : "none";
        }
      }

      if (presets.rejectionReason) {
        const reasonField = document.getElementById("dp-rejection-reason");
        if (reasonField) reasonField.value = presets.rejectionReason;
      }

      if (presets.listType && listTypeSelect) {
        // Ensure the option exists even if the select was locked to "Photo Request"
        if (
          ![...listTypeSelect.options].some(
            (o) => o.value === presets.listType,
          )
        ) {
          const opt = document.createElement("option");
          opt.value = presets.listType;
          opt.textContent = presets.listType;
          listTypeSelect.appendChild(opt);
        }
        listTypeSelect.value = presets.listType;
        // Unlock it in case it was disabled due to an assigned photographer
        listTypeSelect.style.opacity = "1";
        listTypeSelect.style.pointerEvents = "auto";
        listTypeSelect.style.cursor = "pointer";

        if (subTypeWrapper) {
          subTypeWrapper.style.display =
            presets.listType === "Agent Request" ? "block" : "none";
        }
      }

      if (presets.subType) {
        const subTypeSelect = document.getElementById("dp-subtype-select");
        if (subTypeSelect) subTypeSelect.value = presets.subType;
      }
    }

    // Hover states
    const submitBtn = document.getElementById("dp-modal-submit");
    const cancelBtn = document.getElementById("dp-modal-cancel");
    [submitBtn, cancelBtn].forEach((btn) => {
      btn.addEventListener("mouseenter", () => {
        if (!noEditor) btn.style.opacity = "0.8";
      });
      btn.addEventListener("mouseleave", () => {
        if (!noEditor) btn.style.opacity = "1";
      });
    });

    // Close handlers
    document.getElementById("dp-modal-close").onclick = closeLogModal;
    document.getElementById("dp-modal-cancel").onclick = closeLogModal;
    document.getElementById("dp-log-backdrop").onclick = (e) => {
      if (e.target.id === "dp-log-backdrop") closeLogModal();
    };

    // Submit
    submitBtn.onclick = () => {
      if (noEditor) {
        showToast("⚠️ Select your name in the extension popup first.", true);
        return;
      }

      const status = document.getElementById("dp-status-select").value;
      const listType = document.getElementById("dp-listtype-select").value;
      const rawDate = document.getElementById("dp-received-date").value;
      const receivedDate = formatLongDate(rawDate);
      const notes = document.getElementById("dp-notes").value.trim();
      const reShoot =
        document.getElementById("dp-entry-reshoot")?.checked === true;

      const rejectionReason =
        status === "Rejected" || status === "No NOC"
          ? document.getElementById("dp-rejection-reason").value.trim()
          : "";

      const subType =
        listType === "Agent Request"
          ? document.getElementById("dp-subtype-select").value
          : "";

      const reshootPhotographer = reShoot
        ? (document.getElementById("dp-reshoot-photographer")?.value || "").trim()
        : "";

      submitToSheet({
        ...data,
        ...(reShoot ? { photographer: reshootPhotographer || data.photographer } : {}),
        status,
        listType,
        subType,
        receivedDate,
        rejectionReason,
        notes,
        reShoot,
      });
    };
  }

  function modalRow(label, value, labelCol) {
    return `
      <div style="display:flex; gap:10px; align-items:baseline;">
        <span style="color:${labelCol}; min-width:95px; flex-shrink:0; font-size:12px;">${label}</span>
        <span style="font-weight:600; word-break:break-word;">${value || "—"}</span>
      </div>`;
  }

  function closeLogModal() {
    document.getElementById("dp-log-modal")?.remove();
  }

  /* =======================
     QUICK LOG
  ======================= */
  function quickLogToSheet() {
    const data   = gatherAllData();
    const status = getListingStatus();

    // ── Determine List Type from page status (Complete hook now auto-
    // submits Agent Request too — this manual button still opens the
    // modal for it, see below) ──
    let listType = getListTypeFromStatus(status);

    // Fallback: if status not detected, use photographer presence
    if (!listType) {
      listType = data.photographer ? "Photo Request" : "Brochure";
    }

    // QC Approved needs extra details — open full modal instead
    if (listType === "Agent Request") {
      showToast("📋 Agent Request detected — opening Log to Sheet modal.", false);
      setTimeout(openLogModal, 150);
      return;
    }

    const now = new Date();
    const formattedDate = new Intl.DateTimeFormat("en-US", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    }).format(now);

    const payload = {
      ...data,
      status:          "Uploaded",
      listType,
      subType:         "",
      receivedDate:    formattedDate,
      rejectionReason: "",
      notes:           "",
      reShoot:         false,
    };

    showToast("📤 Logging as " + listType + "…");

    chrome.runtime.sendMessage(
      { type: "LOG_TO_SHEET", payload },
      (response) => {
        if (chrome.runtime.lastError) {
          showToast("❌ Extension error: " + chrome.runtime.lastError.message, true);
          return;
        }
        if (response?.duplicate) {
          showToast(
            "⚠️ Already logged!\n" + (response?.error || "This listing was previously logged."),
            true,
          );
        } else if (response?.success) {
          showToast("✅ Quick logged as " + listType + " — Uploaded!");
        } else {
          showToast("❌ Failed: " + (response?.error || "Unknown error"), true);
        }
      },
    );
  }

  /* =======================
     SUBMIT TO SHEET
  ======================= */
  function submitToSheet(data) {
    closeLogModal();
    showToast("📤 Sending to Google Sheet…");

    chrome.runtime.sendMessage(
      { type: "LOG_TO_SHEET", payload: data },
      (response) => {
        if (chrome.runtime.lastError) {
          showToast(
            "❌ Extension error: " + chrome.runtime.lastError.message,
            true,
          );
          return;
        }
        if (response?.duplicate) {
          showToast(
            "⚠️ Already logged!\n" +
              (response?.error || "This listing was previously logged."),
            true,
          );
        } else if (response?.success) {
          showToast("✅ Logged to Google Sheet!");
        } else {
          showToast("❌ Failed: " + (response?.error || "Unknown error"), true);
        }
      },
    );
  }

  /* =======================
     TOAST
  ======================= */
  function showToast(text, isWarning = false) {
    const colors = getExactButtonColors();
    const dark = isSiteDarkMode();

    const toast = document.createElement("div");
    toast.textContent = text;

    Object.assign(toast.style, {
      position: "fixed",
      bottom: "20px",
      right: "30px",
      background: isWarning ? (dark ? "#3b1f1f" : "#fee2e2") : colors.toastBg,
      color: isWarning ? (dark ? "#fca5a5" : "#991b1b") : colors.toastText,
      padding: "12px 16px",
      borderRadius: "8px",
      fontWeight: "600",
      zIndex: "9999",
      whiteSpace: "pre-line",
      maxWidth: "320px",
      overflow: "hidden",
      textOverflow: "ellipsis",
      boxShadow: dark
        ? "0 6px 20px rgba(0,0,0,.6)"
        : "0 6px 20px rgba(0,0,0,.35)",
      opacity: "0",
      transform: "translateY(12px)",
      transition: "opacity .3s ease-out, transform .3s ease-out",
    });

    document.body.appendChild(toast);
    requestAnimationFrame(() => {
      toast.style.opacity = "1";
      toast.style.transform = "translateY(0)";
    });

    setTimeout(() => {
      toast.style.opacity = "0";
      toast.style.transform = "translateY(12px)";
    }, 4500);

    setTimeout(() => toast.remove(), 5000);
  }

  /* =======================
     LISTING STATUS DETECTOR
     Reads the status badge next to the listing reference
     (Offplan Pending, QC Approved, Upload Pending, etc.)
  ======================= */
  function getListingStatus() {
    // Look for known status badge texts near the top of the panel
    const badges = [
      ...document.querySelectorAll(
        '.tag, .badge, [class*="tag"], [class*="badge"], [class*="status"], [class*="label"]',
      ),
    ];

    const knownStatuses = [
      "Offplan Pending",
      "Upload Pending",
      "QC Approved",
      "Stock Photos QC Approved",
      "Stock Photos For QC",
      "Offplan Approved",
      "Upload Approved",
    ];

    for (const badge of badges) {
      const text = badge.textContent.trim();
      if (knownStatuses.some((s) => text.toLowerCase() === s.toLowerCase())) {
        return text;
      }
    }

    // Fallback: scan all visible text nodes
    const container = getScopedContainer();
    const allText = [...container.querySelectorAll("span, div, p")]
      .filter((el) => el.children.length === 0)
      .map((el) => el.textContent.trim())
      .find((t) =>
        knownStatuses.some((s) => t.toLowerCase() === s.toLowerCase()),
      );

    return allText || "";
  }

  // Determines both List Type and (for Agent Request) the sub-type from
  // the CRM's status badge in one place, so both are always derived
  // consistently. "stock" is checked before the generic "qc" match since
  // "Stock Photos QC Approved" contains both substrings — checking qc
  // first would misclassify it as a plain (non-stock) QC approval.
  function getListTypeAndSubType(status) {
    const s = status.toLowerCase();
    if (s.includes("offplan")) return { listType: "Brochure", subType: "" };
    if (s.includes("stock"))   return { listType: "Agent Request", subType: "Stock photos" };
    if (s.includes("qc"))      return { listType: "Agent Request", subType: "Use my own photos" };
    if (s.includes("upload"))  return { listType: "Photo Request", subType: "" };
    return { listType: "", subType: "" };
  }

  function getListTypeFromStatus(status) {
    return getListTypeAndSubType(status).listType;
  }

  /* =======================
     COMPLETE BUTTON INTERCEPTOR
     Hooks into the CRM's Complete button and triggers logging automatically
  ======================= */
  var _completeHooked = false;

  function hookCompleteButton() {
    if (_completeHooked || !isHookEnabled()) return;

    // Find the Complete button. Scoped to the CRM's own native action
    // button (button.custom-dropdown-trigger.are-action.is-wide with a
    // "Complete" span inside) rather than any button on the page whose
    // text happens to say "Complete" — the DP Photo Assigner half of this
    // extension can inject its own backup Complete button into the same
    // drawer toolbar when the CRM's native one is missing (e.g. reshoots),
    // and a plain text match would wrongly pick that up too, double-firing
    // this hook. The dp- id/class check below is a second safety net in
    // case that button's markup ever changes.
    const completeBtn = [...document.querySelectorAll(
      "button.custom-dropdown-trigger.are-action.is-wide"
    )].find((btn) => {
      if (btn.id && btn.id.indexOf("dp-") === 0) return false;
      if (btn.closest('[id^="dp-"]')) return false;
      const span = btn.querySelector("span");
      const text = (span ? span.textContent : btn.textContent).trim().toLowerCase();
      return text === "complete";
    });

    if (!completeBtn) return;

    _completeHooked = true;

    completeBtn.addEventListener(
      "click",
      function (e) {
        const status = getListingStatus();
        const { listType, subType } = getListTypeAndSubType(status);

        if (!isHookEnabled()) return;
        if (!listType) return;

        // Always copy listing info to clipboard on Complete
        const listingInfo = [
          getExactText(/^DP-REQ-\d+/),
          getExactText(/^(DP|CBB|DPA)-(S|R)-\d+/),
          getAllLocations(),
          getUnitPlotNumber(),
        ]
          .filter(Boolean)
          .join(" | ");

        if (listingInfo) {
          navigator.clipboard.writeText(listingInfo).catch(() => {});
        }

        // Agent Request (QC Approved / Stock Photos QC Approved) now
        // auto-submits the same way Brochure/Photo Request already did,
        // instead of opening the modal for a manual confirming click —
        // both listType and subType are fully determined from the status
        // badge above, so there's nothing left requiring a person's input.
        // Gated by the same auto-log toggle as everything else here, so
        // turning that off is still the one switch that disables all of
        // this at once.
        setTimeout(function () {
          quickLogWithType(listType, subType);
        }, 300);
      },
      true,
    );
  }

  /* =======================
     REJECT MODAL SUBMIT INTERCEPTOR
     The CRM's own "Reject" button opens the CRM's own modal (reason textarea +
     Cancel/Submit). We don't hook the outer "Reject" button — that would pop
     our modal on top of theirs. Instead we use one delegated listener that
     fires only when their modal's "Submit" button is actually clicked, so our
     Log to Sheet modal opens right after, never overlapping.
     Pre-fills: Status = Rejected · List Type = Agent Request ·
     Agent Request Type = Use my own photos · Rejection Reason = their textarea
  ======================= */
  document.addEventListener(
    "click",
    function (e) {
      if (!isHookEnabled()) return;

      const btn = e.target.closest("button");
      if (!btn) return;
      if (btn.textContent.trim().toLowerCase() !== "submit") return;

      // Confirm this Submit belongs to the CRM's Reject modal, not some other modal
      const modalCard = btn.closest(".card");
      if (!modalCard) return;

      const heading = modalCard.querySelector(".card-heading h3");
      const isRejectModal =
        heading && heading.textContent.trim().toLowerCase() === "reject";
      const reasonField = modalCard.querySelector(
        'textarea[name="reject_reason"]',
      );

      if (!isRejectModal || !reasonField) return;

      const rejectionReason = reasonField.value.trim();

      // Copy listing info to clipboard, same as Complete
      const listingInfo = [
        getExactText(/^DP-REQ-\d+/),
        getExactText(/^(DP|CBB|DPA)-(S|R)-\d+/),
        getAllLocations(),
        getUnitPlotNumber(),
      ]
        .filter(Boolean)
        .join(" | ");

      if (listingInfo) {
        navigator.clipboard.writeText(listingInfo).catch(() => {});
      }

      // Wait for the CRM's own modal to close before opening ours
      setTimeout(function () {
        openLogModal({
          status: "Rejected",
          listType: "Agent Request",
          subType: "Use my own photos",
          rejectionReason: rejectionReason,
        });
        showToast(
          "📋 Log to Sheet opened — Rejected · Agent Request pre-filled.\n📎 Listing info copied!",
          false,
        );
      }, 400);
    },
    true,
  );

  function quickLogWithType(listType, subType) {
    const data = gatherAllData();

    const now = new Date();
    const formattedDate = new Intl.DateTimeFormat("en-US", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    }).format(now);

    const payload = {
      ...data,
      status: "Uploaded",
      listType: listType,
      subType: subType || "",
      receivedDate: formattedDate,
      rejectionReason: "",
      notes: "",
      reShoot: false,
    };

    const label = listType + (subType ? " · " + subType : "");
    showToast("📤 Logging as " + label + "…");

    chrome.runtime.sendMessage(
      { type: "LOG_TO_SHEET", payload },
      (response) => {
        if (chrome.runtime.lastError) {
          showToast(
            "❌ Extension error: " + chrome.runtime.lastError.message,
            true,
          );
          return;
        }
        if (response?.duplicate) {
          showToast(
            "⚠️ Already logged!\n" +
              (response?.error || "This listing was previously logged."),
            true,
          );
        } else if (response?.success) {
          showToast(
            "✅ Auto-logged as " +
              label +
              " — Uploaded!\n📎 Listing info copied to clipboard!",
          );
        } else {
          showToast("❌ Failed: " + (response?.error || "Unknown error"), true);
        }
      },
    );
  }

  /* =======================
     BUTTONS
  ======================= */
  function createButton(id, text, handler) {
    if (!isSingleRequestPage() || document.getElementById(id)) return;

    let container = document.getElementById("dp-button-container");

    if (!container) {
      // Outer wrapper — holds hamburger + collapsible stack
      const wrapper = document.createElement("div");
      wrapper.id = "dp-button-wrapper";
      Object.assign(wrapper.style, {
        position: "fixed",
        top: "10px",
        right: "20px",
        zIndex: "9997",
        display: "flex",
        flexDirection: "row",
        alignItems: "center",
        gap: "8px",
      });

      const style = document.createElement("style");
      style.innerHTML = `
      #dp-hook-toggle .dp-toggle-track {
        top: -5px;
        width: 38px;
        height: 20px;
        border-radius: 999px;
        background: #64748b;
        position: relative;
        transition: all .25s ease;
      }

      #dp-hook-toggle .dp-toggle-thumb {
        width: 16px;
        height: 16px;
        border-radius: 50%;
        background: white;
        position: absolute;
        top: 2px;
        left: 2px;
        transition: all .25s cubic-bezier(0.4,0,0.2,1);
        box-shadow: 0 2px 6px rgba(0,0,0,.3);
      }

      #dp-hook-toggle.active .dp-toggle-track {
        background: #23a4e4;
      }

      #dp-hook-toggle.active .dp-toggle-thumb {
        transform: translateX(18px);
      }
      `;
      document.head.appendChild(style);

      // Hamburger button
      const hamburger = document.createElement("button");
      hamburger.id = "dp-hamburger";
      hamburger.className = "dp-custom-btn";
      hamburger.title = "Toggle tools";
      hamburger.innerHTML = `
        <span class="dp-ham-line"></span>
        <span class="dp-ham-line"></span>
        <span class="dp-ham-line"></span>`;
      Object.assign(hamburger.style, {
        width: "44px",
        height: "44px",
        padding: "10px",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: "5px",
        marginBottom: "8px",
        borderLeft: "4px solid #22c55e",
      });

      // Toggle Switch
      const toggle = document.createElement("div");
      toggle.id = "dp-hook-toggle";
      toggle.innerHTML = `
        <div class="dp-toggle-track">
          <div class="dp-toggle-thumb"></div>
        </div>
      `;

      Object.assign(toggle.style, {
        width: "44px",
        height: "24px",
        cursor: "pointer",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      });

      function updateToggleUI() {
          if (isHookEnabled()) {
            toggle.classList.add("active");
          } else {
            toggle.classList.remove("active");
          }
        }

        toggle.addEventListener("click", () => {
          const newState = !isHookEnabled();
          setHookEnabled(newState);
          updateToggleUI();

          if (!newState) {
            _completeHooked = false; // reset hook
            showToast("⛔ Auto-log OFF");
          } else {
            hookCompleteButton();
            showToast("✅ Auto-log ON");
          }
        });

        updateToggleUI();

      // Collapsible button stack
      container = document.createElement("div");
      container.id = "dp-button-container";
      Object.assign(container.style, {
        display: "flex",
        flexDirection: "column",
        gap: "10px",
        overflow: "hidden",
        maxHeight: "0px",
        opacity: "0",
        transition:
          "max-height 0.35s cubic-bezier(0.4,0,0.2,1), opacity 0.25s ease",
        transformOrigin: "top right",
      });

      // Toggle open/close
      let isOpen = false;
      hamburger.addEventListener("click", () => {
        isOpen = !isOpen;
        if (isOpen) {
          container.style.maxHeight = "600px";
          container.style.opacity = "1";
          animateHamburger(hamburger, true);
        } else {
          container.style.maxHeight = "0px";
          container.style.opacity = "0";
          animateHamburger(hamburger, false);
        }
      });

      wrapper.appendChild(toggle);
      wrapper.appendChild(hamburger);
      wrapper.appendChild(container);
      document.body.appendChild(wrapper);
    }

    const btn = document.createElement("button");
    btn.id = id;
    btn.textContent = text;
    btn.title = text;
    btn.onclick = handler;
    btn.className = "dp-custom-btn";
    container.appendChild(btn);
  }

  function animateHamburger(hamburger, open) {
    const lines = hamburger.querySelectorAll(".dp-ham-line");
    if (!lines.length) return;
    if (open) {

      lines[0].style.transform = "translateY(7px) rotate(45deg)";
      lines[1].style.opacity = "0";
      lines[1].style.transform = "scaleX(0)";
      lines[2].style.transform = "translateY(-8px) rotate(-45deg)";
    } else {
      // Animate into X
      lines[0].style.transform = "";
      lines[0].style.opacity = "";
      lines[1].style.transform = "";
      lines[1].style.opacity = "";
      lines[2].style.transform = "";
      lines[2].style.opacity = "";
    }
  }

function insertButtons() {
  createButton("copy-listing-btn", "Listing Info", copyListingInfo);
  createButton("copy-sub-location-btn", "Sub-Loc", copySecondLocation);
  createButton("search-sub-location-btn", "Search", searchWithSubLocation);
  createButton("copy-data-btn", "📋 Copy Data", copyAllData);
  createButton("quick-log-btn", "⚡ Quick Log", quickLogToSheet);
  createButton("no-ref-btn", "📷 No Reference", openNoRefModal);
  createButton("log-to-sheet-btn", "Log to Sheet", openLogModal);
  createButton("email-closed-btn", "📧 Email Closed", openEmailClosedModal);

  // ✅ Only hook if toggle is ON
  if (isHookEnabled()) {
    hookCompleteButton();
  }
}

  function removeButtons() {
    document.getElementById("dp-button-wrapper")?.remove();
    _completeHooked = false;
  }

  /* =======================
     SPA NAVIGATION WATCHER
  ======================= */
  window.addEventListener("hashchange", () => {
    removeButtons();
    setTimeout(insertButtons, 400);
  });

  setInterval(() => {
    const panelOpen = isSingleRequestPage();
    const buttonsExist = !!document.getElementById("dp-button-wrapper");

    if (panelOpen && !buttonsExist) insertButtons();
    else if (!panelOpen && buttonsExist) removeButtons();
    else if (panelOpen && !_completeHooked && isHookEnabled()) {
  hookCompleteButton();
}
  }, 600);

  /* =======================
     THEME WATCHER
  ======================= */
  let cachedDarkMode = isSiteDarkMode();

  const themeObserver = new MutationObserver(() => {
    const nowDark = isSiteDarkMode();
    if (nowDark !== cachedDarkMode) {
      cachedDarkMode = nowDark;
      removeButtons();
      setTimeout(insertButtons, 100);
    }
  });

  themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class"],
  });

  /* =======================
     COPY DATA (for Dashboard Edit Modal paste)
  ======================= */
  function copyAllData() {
    const data = gatherAllData();

    // Only the fields needed by the Edit modal paste function
    const payload = {
      __dp_edit_paste__: true, // marker so dashboard knows it's valid
      "DP-REQ Number": data.reqNumber || "",
      "Listing Reference": data.listingRef || "",
      "Listing Link": data.listingLink || "",
      Location: data.location || "",
      "Unit / Plot No": data.unitPlot || "",
      Category: data.category || "",
      Beds: data.beds || "",
      Furnishing: data.furnishing || "",
      "List Type": data.photographer ? "Photo Request" : "",
    };

    const json = JSON.stringify(payload);

    navigator.clipboard
      .writeText(json)
      .then(() =>
        showToast(
          "✅ Data copied! Open the Edit modal on dashboard and click Paste.",
        ),
      )
      .catch(() => showToast("❌ Clipboard write failed.", true));
  }

  /* =======================
     NO REFERENCE MODAL
  ======================= */
  function openNoRefModal() {
    if (document.getElementById("dp-no-ref-modal")) return;
    chrome.storage.local.get(["myName"], ({ myName: editorName }) => {
      _buildNoRefModal(editorName || "");
    });
  }

  function _buildNoRefModal(editorName) {
    if (document.getElementById("dp-no-ref-modal")) return;

    const dark = isSiteDarkMode();
    const noEditor = !editorName;
    const modalBg = dark ? "#1e293b" : "#ffffff";
    const modalText = dark ? "#e5e7eb" : "#1f2937";
    const borderCol = dark ? "#334155" : "#e5e7eb";
    const inputBg = dark ? "#0f172a" : "#f9fafb";
    const labelCol = dark ? "#94a3b8" : "#6b7280";
    const accentCol = "#f97316";

    const inputStyle = `
      width:100%; padding:9px 12px; border-radius:8px;
      border:1px solid ${borderCol}; background:${inputBg};
      color:${modalText}; font-size:14px; outline:none;
    `;

    const overlay = document.createElement("div");
    overlay.id = "dp-no-ref-modal";
    overlay.innerHTML = `
      <div id="dp-no-ref-backdrop" style="
        position:fixed; inset:0; background:rgba(0,0,0,0.6);
        z-index:99999; display:flex; align-items:center; justify-content:center;
        backdrop-filter:blur(4px); font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
      ">
        <div style="
          background:${modalBg}; color:${modalText}; border-radius:14px;
          padding:26px 28px; width:420px; max-width:95vw; max-height:90vh;
          overflow-y:auto; box-shadow:0 24px 64px rgba(0,0,0,0.45);
          border:1px solid ${borderCol};
        ">
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:16px;">
            <div>
              <h2 style="margin:0; font-size:15px; font-weight:700;">📷 No Reference Entry</h2>
              <p style="margin:4px 0 0; font-size:11px; color:${accentCol}; font-weight:600;">
                Status → <strong>No Reference</strong>
                ${noEditor ? " · ⚠️ No editor selected" : " · Logging as: " + editorName}
              </p>
            </div>
            <button id="dp-no-ref-close" style="background:none;border:none;color:${labelCol};font-size:22px;cursor:pointer;line-height:1;">×</button>
          </div>

          <div style="
            background:${inputBg}; border:1px solid ${borderCol}; border-left:3px solid ${accentCol};
            border-radius:8px; padding:10px 14px; margin-bottom:18px;
            font-size:11px; color:${labelCol}; line-height:1.6;
          ">
            Use this for photos received without a listing request — VIP agents, advance bookings, or any shoot without a system reference.
          </div>

          <div style="margin-bottom:14px;">
            <label style="display:block;font-size:11px;font-weight:700;color:${labelCol};margin-bottom:6px;text-transform:uppercase;letter-spacing:.07em;">Location</label>
            <input id="dp-no-ref-location" type="text" placeholder="e.g. Jumeirah Lake Towers, Al Fattan…" style="${inputStyle}">
          </div>

          <div style="margin-bottom:14px;">
            <label style="display:block;font-size:11px;font-weight:700;color:${labelCol};margin-bottom:6px;text-transform:uppercase;letter-spacing:.07em;">Photographer</label>
            <input id="dp-no-ref-photographer" type="text" placeholder="Photographer name" style="${inputStyle}">
          </div>

          <div style="margin-bottom:22px;">
            <label style="display:block;font-size:11px;font-weight:700;color:${labelCol};margin-bottom:6px;text-transform:uppercase;letter-spacing:.07em;">Notes <span style="font-weight:400;text-transform:none;">(optional)</span></label>
            <textarea id="dp-no-ref-notes" rows="3" placeholder="Any additional context…" style="${inputStyle} resize:vertical;"></textarea>
          </div>

          <div style="display:flex;gap:10px;">
            <button id="dp-no-ref-submit" style="
              flex:1; padding:11px 0; background:${noEditor ? "#64748b" : accentCol}; color:#fff;
              border:none; border-radius:8px; font-size:14px; font-weight:700;
              cursor:${noEditor ? "not-allowed" : "pointer"};
              ${noEditor ? "opacity:0.5;" : ""}
            ">📷 Log No Reference</button>
            <button id="dp-no-ref-cancel" style="
              padding:11px 18px; background:${inputBg}; color:${modalText};
              border:1px solid ${borderCol}; border-radius:8px; font-size:14px;
              font-weight:600; cursor:pointer;
            ">Cancel</button>
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    document.getElementById("dp-no-ref-close").onclick = closeNoRefModal;
    document.getElementById("dp-no-ref-cancel").onclick = closeNoRefModal;
    document.getElementById("dp-no-ref-backdrop").onclick = (e) => {
      if (e.target.id === "dp-no-ref-backdrop") closeNoRefModal();
    };

    document.getElementById("dp-no-ref-submit").onclick = () => {
      if (noEditor) {
        showToast("⚠️ Select your name in the extension popup first.", true);
        return;
      }

      const location = document
        .getElementById("dp-no-ref-location")
        .value.trim();
      const photographer = document
        .getElementById("dp-no-ref-photographer")
        .value.trim();
      const notes = document.getElementById("dp-no-ref-notes").value.trim();

      if (!location && !photographer) {
        showToast("⚠️ Please enter at least a location or photographer.", true);
        return;
      }

      const now = new Date();
      const receivedDate = new Intl.DateTimeFormat("en-US", {
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
      }).format(now);

      const data = {
        reqNumber: "",
        listingRef: "",
        listingLink: "",
        location: location,
        unitPlot: "",
        category: "",
        beds: "",
        furnishing: "",
        photographer: photographer,
        listType: "",
        status: "No Reference",
        receivedDate: receivedDate,
        rejectionReason: "",
        subType: "",
        notes: notes,
      };

      closeNoRefModal();
      submitToSheet(data);
    };
  }

  function closeNoRefModal() {
    document.getElementById("dp-no-ref-modal")?.remove();
  }

  /* =======================
     EMAIL CLOSED MODAL
  ======================= */
  function openEmailClosedModal() {
    if (document.getElementById("dp-email-closed-modal")) return;
    chrome.storage.local.get(["myName"], ({ myName: editorName }) => {
      _buildEmailClosedModal(editorName || "");
    });
  }

  function _buildEmailClosedModal(editorName) {
    if (document.getElementById("dp-email-closed-modal")) return;

    const dark = isSiteDarkMode();
    const noEditor = !editorName;
    const modalBg = dark ? "#1e293b" : "#ffffff";
    const modalText = dark ? "#e5e7eb" : "#1f2937";
    const borderCol = dark ? "#334155" : "#e5e7eb";
    const inputBg = dark ? "#0f172a" : "#f9fafb";
    const labelCol = dark ? "#94a3b8" : "#6b7280";
    const accentCol = "#22d3ee";

    const inputStyle = `
      width:100%; padding:9px 12px; border-radius:8px;
      border:1px solid ${borderCol}; background:${inputBg};
      color:${modalText}; font-size:14px; outline:none;
    `;

    const overlay = document.createElement("div");
    overlay.id = "dp-email-closed-modal";
    overlay.innerHTML = `
      <div id="dp-email-closed-backdrop" style="
        position:fixed; inset:0; background:rgba(0,0,0,0.6);
        z-index:99999; display:flex; align-items:center; justify-content:center;
        backdrop-filter:blur(4px); font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
      ">
        <div style="
          background:${modalBg}; color:${modalText}; border-radius:14px;
          padding:26px 28px; width:400px; max-width:95vw; max-height:90vh;
          overflow-y:auto; box-shadow:0 24px 64px rgba(0,0,0,0.45);
          border:1px solid ${borderCol};
        ">
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:16px;">
            <div>
              <h2 style="margin:0; font-size:15px; font-weight:700;">📧 Log Email Closed</h2>
              <p style="margin:4px 0 0; font-size:11px; color:${accentCol}; font-weight:600;">
                Status → <strong>Closed</strong>
                ${noEditor ? " · ⚠️ No editor selected" : " · Logging as: " + editorName}
              </p>
            </div>
            <button id="dp-email-closed-close" style="background:none;border:none;color:${labelCol};font-size:22px;cursor:pointer;line-height:1;">×</button>
          </div>

          <div style="
            background:${inputBg}; border:1px solid ${borderCol}; border-left:3px solid ${accentCol};
            border-radius:8px; padding:10px 14px; margin-bottom:18px;
            font-size:11px; color:${labelCol}; line-height:1.6;
          ">
            No reference number needed — just what the email was about. Logged with today's date/time automatically.
          </div>

          <div style="margin-bottom:22px;">
            <label style="display:block;font-size:11px;font-weight:700;color:${labelCol};margin-bottom:6px;text-transform:uppercase;letter-spacing:.07em;">Subject</label>
            <input id="dp-email-closed-subject" type="text" placeholder="e.g. Follow-up on missing photos" style="${inputStyle}">
          </div>

          <div style="display:flex;gap:10px;">
            <button id="dp-email-closed-submit" style="
              flex:1; padding:11px 0; background:${noEditor ? "#64748b" : accentCol}; color:#fff;
              border:none; border-radius:8px; font-size:14px; font-weight:700;
              cursor:${noEditor ? "not-allowed" : "pointer"};
              ${noEditor ? "opacity:0.5;" : ""}
            ">✓ Log to Sheet</button>
            <button id="dp-email-closed-cancel" style="
              padding:11px 18px; background:${inputBg}; color:${modalText};
              border:1px solid ${borderCol}; border-radius:8px; font-size:14px;
              font-weight:600; cursor:pointer;
            ">Cancel</button>
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    const subjectInput = document.getElementById("dp-email-closed-subject");
    subjectInput.focus();

    document.getElementById("dp-email-closed-close").onclick = closeEmailClosedModal;
    document.getElementById("dp-email-closed-cancel").onclick = closeEmailClosedModal;
    document.getElementById("dp-email-closed-backdrop").onclick = (e) => {
      if (e.target.id === "dp-email-closed-backdrop") closeEmailClosedModal();
    };

    const submitBtn = document.getElementById("dp-email-closed-submit");
    submitBtn.onclick = () => {
      if (noEditor) {
        showToast("⚠️ Select your name in the extension popup first.", true);
        return;
      }

      const subject = subjectInput.value.trim();
      if (!subject) {
        showToast("⚠️ Please enter a subject.", true);
        subjectInput.focus();
        return;
      }

      submitBtn.disabled = true;
      submitBtn.textContent = "Logging…";

      chrome.runtime.sendMessage(
        { type: "LOG_EMAIL_CLOSED", payload: { subject } },
        (response) => {
          if (chrome.runtime.lastError) {
            showToast("❌ " + chrome.runtime.lastError.message, true);
            submitBtn.disabled = false;
            submitBtn.textContent = "✓ Log to Sheet";
            return;
          }

          if (!(response && response.success)) {
            showToast("❌ " + (response?.error || "Could not log — try again."), true);
            submitBtn.disabled = false;
            submitBtn.textContent = "✓ Log to Sheet";
            return;
          }

          // Per request: copy "Email Closed | <Subject>" to the clipboard
          // once it's actually logged, so it's ready to paste wherever
          // this needs to be referenced next (e.g. back into the CRM).
          navigator.clipboard.writeText(`Email Closed | ${subject}`).catch(() => {});

          showToast("✅ Logged and copied to clipboard.");
          closeEmailClosedModal();
        }
      );
    };
  }

  function closeEmailClosedModal() {
    document.getElementById("dp-email-closed-modal")?.remove();
  }

  /* =======================
     INIT
  ======================= */
  setTimeout(insertButtons, 800);
})();
