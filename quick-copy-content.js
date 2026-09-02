(function () {
  "use strict";

  const SEP = " _ ";

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
        ? { bg: "#202c33", border: "#6b7280", text: "#cbd5e1", toastBg: "#1e293b", toastText: "#e5e7eb" }
        : { bg: "#ffffff", border: "#d1d5db", text: "#1f2937", toastBg: "#aeecb0", toastText: "#1f2937" };
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
      boxShadow: dark ? "0 6px 20px rgba(0,0,0,.6)" : "0 6px 20px rgba(0,0,0,.35)",
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
     DATA HELPERS
  ======================= */
  // Duplicated in copier-content.js — keep both in sync if this changes.
  function getScopedContainer() {
    return (
      document.querySelector(".listing-detail, main, #app, .request-detail") ||
      document.body
    );
  }

  // ⚠️ CRITICAL — do NOT modify these regex patterns
  // Duplicated in copier-content.js — keep both in sync if this regex changes.
  function getExactText(regex) {
    const container = getScopedContainer();
    return (
      [...container.querySelectorAll("span, div")]
        .filter((el) => el.children.length === 0)
        .map((el) => el.textContent.trim())
        .find((text) => regex.test(text)) || ""
    );
  }

  function getUnitPlotNumber() {
    const container = getScopedContainer();
    const text = (container.innerText || "")
      .replace(/\s+/g, " ")
      .slice(0, 5000);

    const STOP_WORDS =
      "Location|Published|Beds|Baths|Furnishing|Pending|Approved|Scheduled|Hold|Completed|Rejected";

    const patterns = [
      new RegExp(`Unit\\s*\\/\\s*Plot\\s*(?:No\\.?\\s*)?[:\\-]?\\s*([^\\n]+?)(?=\\s(?:${STOP_WORDS})|$)`, "i"),
      new RegExp(`Office\\s*[:\\-]?\\s*([^\\n]+?)(?=\\s(?:${STOP_WORDS})|$)`, "i"),
      new RegExp(`Unit\\s*(?:No\\.?\\s*)?[:\\-]?\\s*([^\\n]+?)(?=\\s(?:${STOP_WORDS})|$)`, "i"),
      new RegExp(`Plot\\s*(?:No\\.?\\s*)?[:\\-]?\\s*([^\\n]+?)(?=\\s(?:${STOP_WORDS})|$)`, "i"),
    ];

    for (const p of patterns) {
      const m = text.match(p);
      if (m) return m[1].replace(/^No\s+/i, "").trim();
    }

    return "";
  }

  // Returns location parts as an array split for -- joining.
  // "Al Reem Island , Marina Square" + "Ocean Terrace"
  //   → ["Al Reem Island", "Marina Square", "Ocean Terrace"]
  function getLocationParts() {
    const metaBlocks = [...document.querySelectorAll(".meta.is-flex")];
    const parts = [];

    for (const block of metaBlocks) {
      const loc =
        block.dataset.tooltip?.trim() ||
        block.textContent.replace(/\s+/g, " ").trim();

      if (!loc || /Beds|Baths|Furnishing/i.test(loc)) continue;

      if (parts.length === 0 && loc.includes(" , ")) {
        // Split "Al Reem Island , Marina Square" into two separate parts
        const [area, sub] = loc.split(" , ");
        if (area?.trim()) parts.push(area.trim());
        if (sub?.trim()) parts.push(sub.trim());
      } else {
        parts.push(loc);
      }

      if (parts.length >= 3) break;
    }

    return parts;
  }

  /* =======================
     COPY FUNCTION
  ======================= */
  function copyListingInfo(locationOnly = false) {
    const locationParts = getLocationParts();

    const parts = locationOnly
      ? [...locationParts, getUnitPlotNumber()]
      : [
          getExactText(/^(DP|CBB|DPA)-(S|R)-\d+/), // ⚠️ critical — do not modify
          ...locationParts,
          getUnitPlotNumber(),
        ];

    const result = parts.filter(Boolean).join(SEP);

    if (!result) {
      showToast("⚠️ No listing info found on this page.", true);
      return;
    }

    navigator.clipboard
      .writeText(result)
      .then(() => showToast("✅ Copied:\n" + result))
      .catch(() => showToast("❌ Clipboard write failed.", true));
  }

  /* =======================
     BUTTON INJECTION
  ======================= */
  // Duplicated in copier-content.js — keep both in sync if this changes.
  function isSingleRequestPage() {
    const hashMatch = /^#Request#.+/.test(location.hash);
    const panelOpen = !!document.querySelector("button.preview-close-button");
    return hashMatch || panelOpen;
  }

  function makeCopyButton(id, label, locationOnly) {
    const btn = document.createElement("button");
    btn.id = id;
    btn.className = "button custom-dropdown-trigger are-action";
    btn.style.cssText = "margin-right: 8px; top:3px; height: 100%; font-weight: 600; white-space: nowrap;";
    btn.innerHTML = `
      <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="currentColor" style="margin-right:5px;flex-shrink:0;">
        <path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/>
      </svg>
      <span>${label}</span>
    `;

    btn.addEventListener("click", () => copyListingInfo(locationOnly));
    return btn;
  }

  function injectButton() {
    const actionsEl = document.querySelector(".preview-actions.is-flex");
    if (!actionsEl) return;

    const dropdown = actionsEl.querySelector(".dropdown");

    if (!document.getElementById("dp-req-copy-btn")) {
      const btn = makeCopyButton("dp-req-copy-btn", "Copy", false);
      if (dropdown) {
        actionsEl.insertBefore(btn, dropdown);
      } else {
        actionsEl.prepend(btn);
      }
    }

    if (!document.getElementById("dp-req-copy-loc-btn")) {
      const locBtn = makeCopyButton("dp-req-copy-loc-btn", "Copy Location", true);
      if (dropdown) {
        actionsEl.insertBefore(locBtn, dropdown);
      } else {
        actionsEl.prepend(locBtn);
      }
    }
  }

  function removeButton() {
    document.getElementById("dp-req-copy-btn")?.remove();
    document.getElementById("dp-req-copy-loc-btn")?.remove();
  }

  /* =======================
     SPA NAVIGATION WATCHER
  ======================= */
  window.addEventListener("hashchange", () => {
    removeButton();
    setTimeout(injectButton, 400);
  });

  setInterval(() => {
    const panelOpen = isSingleRequestPage();
    const btnExists =
      !!document.getElementById("dp-req-copy-btn") &&
      !!document.getElementById("dp-req-copy-loc-btn");

    if (panelOpen && !btnExists) injectButton();
    else if (!panelOpen && btnExists) removeButton();
  }, 600);

  /* =======================
     THEME WATCHER
  ======================= */
  let cachedDarkMode = isSiteDarkMode();

  const themeObserver = new MutationObserver(() => {
    const nowDark = isSiteDarkMode();
    if (nowDark !== cachedDarkMode) {
      cachedDarkMode = nowDark;
      removeButton();
      setTimeout(injectButton, 100);
    }
  });

  themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class"],
  });

  /* =======================
     INIT
  ======================= */
  setTimeout(injectButton, 800);
})();
