// Runs on scout-source.com: copies the app's structured fill profile
// (written by the Profile page) into extension storage, so the filler
// works on any site without needing a login of its own.
function sync() {
  try {
    var raw = localStorage.getItem("scout_fill_profile");
    if (!raw) return;
    var data = JSON.parse(raw);
    if (data && data.v) {
      chrome.storage.local.set({ fillProfile: data, syncedAt: Date.now() });
    }
  } catch (e) {
    /* next visit re-syncs */
  }
}
sync();
setInterval(sync, 15000);
