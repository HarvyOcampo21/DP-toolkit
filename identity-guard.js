(function () {
  "use strict";

  // Loaded first on every page this extension touches (photo request pages
  // + site-wide for select.js). Guards against double-injection since it's
  // listed in more than one content_scripts entry in the manifest.
  if (window.__dpIdentityGuardLoaded) return;
  window.__dpIdentityGuardLoaded = true;

  // Live-synced copy of chrome.storage.local's "myName" — read once on
  // load, then kept current via onChanged so a name picked in the popup
  // takes effect immediately without needing a page refresh.
  let currentName = "";

  chrome.storage.local.get(["myName"], result => {
    currentName = (result && result.myName) || "";
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.myName) {
      currentName = changes.myName.newValue || "";
    }
  });

  function isSiteDarkMode() {
    return (
      document.documentElement.classList.contains("dark") ||
      document.body.classList.contains("dark") ||
      document.querySelector(".theme-toggle input")?.checked === true
    );
  }

  function showNameWarning() {
    const existing = document.getElementById("dp-name-warning-toast");
    if (existing) existing.remove();

    const dark = isSiteDarkMode();
    const toast = document.createElement("div");
    toast.id = "dp-name-warning-toast";
    toast.textContent = "⚠️ Select your name in the DP Toolkit popup before using this feature.";

    Object.assign(toast.style, {
      position: "fixed",
      bottom: "20px",
      right: "30px",
      background: dark ? "#3b1f1f" : "#fee2e2",
      color: dark ? "#fca5a5" : "#991b1b",
      padding: "12px 16px",
      borderRadius: "8px",
      fontWeight: "600",
      fontSize: "13px",
      lineHeight: "1.4",
      zIndex: "2147483647",
      maxWidth: "320px",
      boxShadow: dark ? "0 6px 20px rgba(0,0,0,.6)" : "0 6px 20px rgba(0,0,0,.35)",
      opacity: "0",
      transform: "translateY(12px)",
      transition: "opacity .3s ease-out, transform .3s ease-out",
      fontFamily: "-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif",
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

  // Shown by background.js right after the extension itself reloads (see
  // dpPendingTabRefresh in background.js) — a heads-up that this tab is
  // about to auto-refresh, with a live countdown, instead of the page just
  // silently reloading out of nowhere a few seconds later. Deliberately a
  // non-blocking toast, not a real alert()/confirm() — those freeze the
  // whole page until dismissed, which is exactly the wrong thing to do
  // right before the page is about to reload anyway.
  function showRefreshCountdown(seconds) {
    const existing = document.getElementById("dp-refresh-countdown-toast");
    if (existing) existing.remove();

    const dark = isSiteDarkMode();
    const toast = document.createElement("div");
    toast.id = "dp-refresh-countdown-toast";

    Object.assign(toast.style, {
      position: "fixed",
      bottom: "20px",
      right: "30px",
      background: dark ? "#0f2e2b" : "#e6fbf7",
      color: dark ? "#5eead4" : "#0f766e",
      padding: "12px 16px",
      borderRadius: "8px",
      fontWeight: "600",
      fontSize: "13px",
      lineHeight: "1.4",
      zIndex: "2147483647",
      maxWidth: "320px",
      boxShadow: dark ? "0 6px 20px rgba(0,0,0,.6)" : "0 6px 20px rgba(0,0,0,.35)",
      opacity: "0",
      transform: "translateY(12px)",
      transition: "opacity .3s ease-out, transform .3s ease-out",
      fontFamily: "-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif",
    });

    let remaining = seconds;
    const setText = () => {
      toast.textContent = `🔄 DP Toolkit updated — this page will refresh automatically in ${remaining}s...`;
    };
    setText();

    document.body.appendChild(toast);
    requestAnimationFrame(() => {
      toast.style.opacity = "1";
      toast.style.transform = "translateY(0)";
    });

    const tick = setInterval(() => {
      remaining -= 1;
      if (remaining <= 0) {
        clearInterval(tick);
        // Normally the actual page reload (triggered independently by
        // background.js on the same timer) happens right around now and
        // wipes this DOM anyway — this fade-out is just a graceful
        // fallback in case that reload is ever delayed for any reason,
        // so the toast never overstays its welcome.
        toast.style.opacity = "0";
        toast.style.transform = "translateY(12px)";
        setTimeout(() => toast.remove(), 300);
        return;
      }
      setText();
    }, 1000);
  }

  // Small reminder toast for when the person says "no" to auto-refresh —
  // e.g. because they deliberately kept a CRM tab open to avoid losing
  // in-progress data on it. Amber, not red — this isn't an error, just a
  // "don't forget" nudge, and it stays up long enough to actually notice
  // (10s) rather than the 5s used for routine confirmations elsewhere.
  function showManualRefreshReminder() {
    const existing = document.getElementById("dp-manual-refresh-toast");
    if (existing) existing.remove();

    const dark = isSiteDarkMode();
    const toast = document.createElement("div");
    toast.id = "dp-manual-refresh-toast";
    toast.textContent = "⚠️ Remember to manually refresh your open CRM tab(s) to get the latest DP Toolkit update.";

    Object.assign(toast.style, {
      position: "fixed",
      bottom: "20px",
      right: "30px",
      background: dark ? "#3b2f14" : "#fef3c7",
      color: dark ? "#fbbf24" : "#92400e",
      padding: "12px 16px",
      borderRadius: "8px",
      fontWeight: "600",
      fontSize: "13px",
      lineHeight: "1.4",
      zIndex: "2147483647",
      maxWidth: "320px",
      boxShadow: dark ? "0 6px 20px rgba(0,0,0,.6)" : "0 6px 20px rgba(0,0,0,.35)",
      opacity: "0",
      transform: "translateY(12px)",
      transition: "opacity .3s ease-out, transform .3s ease-out",
      fontFamily: "-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif",
    });

    document.body.appendChild(toast);
    requestAnimationFrame(() => {
      toast.style.opacity = "1";
      toast.style.transform = "translateY(0)";
    });
    setTimeout(() => {
      toast.style.opacity = "0";
      toast.style.transform = "translateY(12px)";
    }, 9500);
    setTimeout(() => toast.remove(), 10000);
  }

  // Asks whether to auto-refresh all open CRM tabs after an extension
  // update, rather than doing it unconditionally — someone may have a tab
  // open on purpose (e.g. mid-edit on a form) and auto-reloading it would
  // lose that. A custom non-blocking card, not a real confirm() — that
  // would freeze the whole page, which is a worse experience than the
  // thing it's trying to prevent. onResponse is called with true/false.
  function showRefreshConfirm(tabCount, onResponse) {
    const existing = document.getElementById("dp-refresh-confirm-toast");
    if (existing) existing.remove();

    const dark = isSiteDarkMode();
    const card = document.createElement("div");
    card.id = "dp-refresh-confirm-toast";

    Object.assign(card.style, {
      position: "fixed",
      bottom: "20px",
      right: "30px",
      background: dark ? "#0f2e2b" : "#e6fbf7",
      color: dark ? "#5eead4" : "#0f766e",
      padding: "14px 16px",
      borderRadius: "10px",
      fontSize: "13px",
      lineHeight: "1.4",
      zIndex: "2147483647",
      maxWidth: "320px",
      boxShadow: dark ? "0 6px 20px rgba(0,0,0,.6)" : "0 6px 20px rgba(0,0,0,.35)",
      opacity: "0",
      transform: "translateY(12px)",
      transition: "opacity .3s ease-out, transform .3s ease-out",
      fontFamily: "-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif",
    });

    const msg = document.createElement("div");
    msg.style.fontWeight = "600";
    msg.style.marginBottom = "10px";
    const plural = tabCount === 1 ? "tab" : "tabs";
    msg.textContent = `🔄 DP Toolkit updated. Refresh ${tabCount} open CRM ${plural} now?`;
    card.appendChild(msg);

    const btnRow = document.createElement("div");
    Object.assign(btnRow.style, { display: "flex", gap: "8px" });

    function respond(confirmed) {
      card.style.opacity = "0";
      card.style.transform = "translateY(12px)";
      setTimeout(() => card.remove(), 300);
      onResponse(confirmed);
      if (!confirmed) showManualRefreshReminder();
    }

    const yesBtn = document.createElement("button");
    yesBtn.type = "button";
    yesBtn.textContent = "Yes, refresh";
    Object.assign(yesBtn.style, {
      flex: "1", padding: "7px 10px", borderRadius: "6px", border: "none",
      background: dark ? "#5eead4" : "#0f766e", color: dark ? "#0f2e2b" : "#fff",
      fontWeight: "700", fontSize: "12.5px", cursor: "pointer",
    });
    yesBtn.addEventListener("click", () => respond(true));

    const noBtn = document.createElement("button");
    noBtn.type = "button";
    noBtn.textContent = "No, I'll do it myself";
    Object.assign(noBtn.style, {
      flex: "1", padding: "7px 10px", borderRadius: "6px",
      border: `1px solid ${dark ? "#5eead4" : "#0f766e"}`, background: "transparent",
      color: dark ? "#5eead4" : "#0f766e", fontWeight: "700", fontSize: "12.5px", cursor: "pointer",
    });
    noBtn.addEventListener("click", () => respond(false));

    btnRow.appendChild(yesBtn);
    btnRow.appendChild(noBtn);
    card.appendChild(btnRow);

    document.body.appendChild(card);
    requestAnimationFrame(() => {
      card.style.opacity = "1";
      card.style.transform = "translateY(0)";
    });
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message && message.type === "DP_SHOW_REFRESH_COUNTDOWN") {
      showRefreshCountdown(message.seconds || 5);
      return; // no response needed
    }
    if (message && message.type === "DP_CONFIRM_REFRESH_TABS") {
      showRefreshConfirm(message.tabCount || 1, confirmed => sendResponse({ confirmed }));
      return true; // keep the message channel open for the async button click
    }
  });

  // Call at the top of any action that writes to the Sheet (assign,
  // unassign, hold, complete, reject, downloaded toggle, logger submits,
  // etc.). Returns true and lets the caller proceed if a name is set;
  // otherwise shows the warning toast and returns false — the caller
  // should bail out immediately without performing the action.
  window.dpRequireName = function dpRequireName() {
    if (currentName) return true;
    showNameWarning();
    return false;
  };

  // For callers that want the live value directly instead of re-reading
  // chrome.storage.local themselves.
  window.dpGetMyName = function dpGetMyName() {
    return currentName;
  };
})();
