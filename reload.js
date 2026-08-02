// Triggers a full reload of this extension from disk (picks up updated
// files). The actual CRM tab refresh happens ~2s *after* the extension
// restarts, not here — see the pendingTabRefresh handling in background.js.
// (A setTimeout placed after chrome.runtime.reload() in this same script
// would very likely never fire: that call tears down this page's own
// execution context almost immediately, so the delayed step has to live
// somewhere that survives the reload instead.)
chrome.storage.local.set({ dpPendingTabRefresh: Date.now() }, () => {
  chrome.runtime.reload();
});

// Best-effort: close this tab shortly after. If Chrome blocks it
// (tabs not opened by a script can't always self-close), it's harmless
// to just leave this blank tab open.
setTimeout(() => window.close(), 300);
