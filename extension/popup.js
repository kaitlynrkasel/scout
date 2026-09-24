// Popup: shows sync status, triggers the filler on the active tab, and
// offers one-click copies for the pieces forms ask for one at a time.
const $ = (id) => document.getElementById(id);

function row(parent, title, sub, copyText) {
  const div = document.createElement("div");
  div.className = "row";
  const t = document.createElement("div");
  t.className = "t";
  const b = document.createElement("b");
  b.textContent = title;
  t.appendChild(b);
  if (sub) {
    const s = document.createElement("span");
    s.textContent = sub;
    t.appendChild(s);
  }
  const btn = document.createElement("button");
  btn.textContent = "Copy";
  btn.addEventListener("click", async () => {
    await navigator.clipboard.writeText(copyText);
    btn.textContent = "Copied";
    setTimeout(() => (btn.textContent = "Copy"), 1200);
  });
  div.appendChild(t);
  div.appendChild(btn);
  parent.appendChild(div);
}

(async () => {
  const { fillProfile: p, syncedAt } = await chrome.storage.local.get(["fillProfile", "syncedAt"]);
  if (!p) {
    $("status").textContent = "No profile synced yet.";
    $("warn").hidden = false;
    return;
  }
  const when = syncedAt ? new Date(syncedAt).toLocaleDateString() : "";
  $("status").textContent = (p.name ? p.name + " · " : "") + "profile synced" + (when ? " " + when : "");

  const copies = $("copies");
  const kicker = (label) => {
    const k = document.createElement("div");
    k.className = "k";
    k.textContent = label;
    copies.appendChild(k);
  };

  const basics = [
    ["Email", p.email],
    ["Phone", p.phone],
    ["LinkedIn", p.linkedin],
    ["Website", p.website],
    ["Location", p.location],
    ["School", p.school],
    ["Major", p.major],
  ].filter(([, v]) => v);
  if (basics.length) {
    kicker("Basics");
    for (const [label, v] of basics) row(copies, label, v, v);
  }

  if ((p.experience || []).length) {
    kicker("Experience, one role per copy");
    for (const r of p.experience) {
      const text = [
        [r.title, r.company].filter(Boolean).join(" - ") + (r.dates ? " (" + r.dates + ")" : ""),
        ...(r.bullets || []).map((b) => "- " + b),
      ].join("\n");
      row(copies, r.title || "Role", [r.company, r.dates].filter(Boolean).join(" · "), text);
    }
  }
  if ((p.skills || []).length) {
    kicker("Skills");
    row(copies, "All skills", p.skills.join(", "), p.skills.join(", "));
  }
})();

$("fill").addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) return;
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["fill.js"] });
    window.close();
  } catch (e) {
    $("status").textContent = "Can't fill this page (browser pages and some sites are off limits).";
  }
});
