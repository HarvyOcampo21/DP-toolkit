// Triggers a full reload of this extension from disk (picks up updated
// files), and refreshes every currently-open CRM tab too, so nobody has
// to manually reload each tab to pick up the new content-script version.

chrome.tabs.query({ url: "https://newcrm.drivenproperties.com/*" }, (tabs) => {
  tabs.forEach(tab => {
    if (tab.id !== undefined) chrome.tabs.reload(tab.id);
  });

  // Reload the extension itself only after kicking off the tab reloads
  // above — chrome.runtime.reload() tears down this very page's own
  // execution context almost immediately, so anything that needs to run
  // has to be queued before this call, not after.
  chrome.runtime.reload();
});

// Best-effort: close this tab shortly after. If Chrome blocks it
// (tabs not opened by a script can't always self-close), it's harmless
// to just leave this blank tab open.
setTimeout(() => window.close(), 300);
