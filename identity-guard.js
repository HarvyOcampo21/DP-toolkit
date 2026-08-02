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

  chrome.runtime.onMessage.addListener(message => {
    if (message && message.type === "DP_SHOW_REFRESH_COUNTDOWN") {
      showRefreshCountdown(message.seconds || 5);
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
