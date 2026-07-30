// Triggers a full reload of this extension from disk (picks up updated files).
chrome.runtime.reload();

// Best-effort: close this tab shortly after. If Chrome blocks it
// (tabs not opened by a script can't always self-close), it's harmless
// to just leave this blank tab open.
setTimeout(() => window.close(), 300);
