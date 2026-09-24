// Injected into the active tab when the popup's Fill button is pressed.
// Reads the synced Scout profile from chrome.storage and fills what it can
// recognize. It NEVER submits anything: every fill is visible (highlighted)
// and yours to review.
(async () => {
  const { fillProfile: p } = await chrome.storage.local.get("fillProfile");
  if (!p) {
    alert("Open scout-source.com once while signed in so the extension can read your profile, then try again.");
    return;
  }

  const nameParts = String(p.name || "").trim().split(/\s+/);
  const firstName = nameParts[0] || "";
  const lastName = nameParts.slice(1).join(" ");
  const expText = (p.experience || [])
    .map((r) =>
      [
        [r.title, r.company].filter(Boolean).join(" - ") + (r.dates ? " (" + r.dates + ")" : ""),
        ...(r.bullets || []).map((b) => "- " + b),
      ].join("\n")
    )
    .join("\n\n");

  // What we know, keyed by matchers run against a field's combined "label
  // text" (label, aria-label, placeholder, name, id, autocomplete).
  const RULES = [
    { re: /first\s*name|given\s*name/i, value: firstName },
    { re: /last\s*name|family\s*name|surname/i, value: lastName },
    { re: /full\s*name|your\s*name|^name$|\bname\b/i, not: /company|employer|organization|school|university|reference|parent|guardian/i, value: p.name, weak: true },
    { re: /e-?mail/i, value: p.email },
    { re: /phone|mobile|tel(ephone)?\b/i, value: p.phone },
    { re: /linked\s*in/i, value: p.linkedin },
    { re: /portfolio|personal\s*site|website|\burl\b/i, value: p.website },
    { re: /city|location|address/i, value: p.location, weak: true },
    { re: /school|university|college|institution/i, value: p.school },
    { re: /major|field\s*of\s*study|concentration/i, value: p.major },
    { re: /degree/i, value: p.major, weak: true },
    { re: /skills/i, value: (p.skills || []).join(", ") },
    { re: /(work|relevant|professional)\s*(experience|history)|experience\s*summary/i, value: expText, textareaOnly: true },
    { re: /summary|about\s*(you|yourself)/i, value: p.summary, textareaOnly: true, weak: true },
  ];

  // React/ATS forms ignore plain .value writes; go through the native setter
  // and fire the events frameworks listen for.
  const setNative = (el, value) => {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value");
    if (setter && setter.set) setter.set.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  };

  const labelTextFor = (el) => {
    const bits = [];
    if (el.id) {
      const lab = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
      if (lab) bits.push(lab.textContent || "");
    }
    const wrap = el.closest("label");
    if (wrap) bits.push(wrap.textContent || "");
    bits.push(el.getAttribute("aria-label") || "");
    bits.push(el.getAttribute("placeholder") || "");
    bits.push(el.getAttribute("name") || "");
    bits.push(el.id || "");
    bits.push(el.getAttribute("autocomplete") || "");
    return bits.join(" ").slice(0, 300);
  };

  const AUTOCOMPLETE = {
    "given-name": firstName,
    "family-name": lastName,
    name: p.name,
    email: p.email,
    tel: p.phone,
    url: p.website,
    "address-level2": p.location,
  };

  let filled = 0;
  const els = document.querySelectorAll("input, textarea");
  for (const el of els) {
    const type = (el.getAttribute("type") || "text").toLowerCase();
    if (["hidden", "checkbox", "radio", "file", "submit", "button", "password"].includes(type)) continue;
    if (el.disabled || el.readOnly) continue;
    if (el.value && el.value.trim()) continue; // never overwrite what's typed
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) continue;

    let value = "";
    const ac = (el.getAttribute("autocomplete") || "").toLowerCase();
    if (AUTOCOMPLETE[ac]) value = AUTOCOMPLETE[ac];
    if (!value) {
      const label = labelTextFor(el);
      let weakHit = "";
      for (const rule of RULES) {
        if (!rule.value) continue;
        if (rule.textareaOnly && !(el instanceof HTMLTextAreaElement)) continue;
        if (rule.not && rule.not.test(label)) continue;
        if (rule.re.test(label)) {
          if (rule.weak) {
            if (!weakHit) weakHit = rule.value;
          } else {
            value = rule.value;
            break;
          }
        }
      }
      if (!value) value = weakHit;
    }
    if (type === "email" && !value) value = p.email;
    if (type === "tel" && !value) value = p.phone;
    if (!value) continue;

    setNative(el, value);
    el.style.outline = "2px solid #8A5A34";
    el.style.outlineOffset = "1px";
    filled++;
  }

  // A small, self-removing tally so the result is obvious without a popup.
  const note = document.createElement("div");
  note.textContent = filled
    ? "Scout filled " + filled + " field" + (filled === 1 ? "" : "s") + ". Review before submitting."
    : "Scout couldn't recognize any empty fields here. Use the copy buttons in the extension popup instead.";
  note.style.cssText =
    "position:fixed;bottom:18px;right:18px;z-index:2147483647;background:#241C13;color:#F5F2EB;" +
    "font:600 13px/1.4 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;padding:10px 14px;" +
    "border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.25);max-width:320px";
  document.body.appendChild(note);
  setTimeout(() => note.remove(), 6000);
})();
