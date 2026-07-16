// Branded auto-tune notification email: the HTML template + the numeric-diff
// helper that turns two near-identical rule walls into a compact 'what
// actually changed' line. Lives in lib/ so it's unit-testable (route files
// can only export handlers).

// The tuner mostly moves NUMBERS inside a long clause — so show the numbers.
// Pairs up the numeric tokens of the old/new text and returns the ones that
// changed ("0.02 → 0.01"). Empty when the shapes differ too much to pair.
export function diffNumbers(oldS: string, newS: string): string[] {
  const nums = (s: string) => s.match(/\d+(?:\.\d+)?%?/g) || [];
  const a = nums(oldS);
  const b = nums(newS);
  if (!a.length || a.length !== b.length) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < a.length && out.length < 6; i++) {
    if (a[i] !== b[i]) {
      const pair = `${a[i]} → ${b[i]}`;
      if (!seen.has(pair)) {
        seen.add(pair);
        out.push(pair);
      }
    }
  }
  return out;
}

export function htmlEsc(s: string): string {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// Branded, email-client-safe (tables + inline styles) notification. Same warm
// Scout palette as the site: cream canvas, white card, Mystic Navy header,
// espresso text. The full rule text intentionally stays OUT of the email — the
// in-app change log holds it; the email shows only what actually changed.
export function renderTuneEmailHtml(o: {
  positive: boolean;
  title: string;
  learned: string;
  aside?: string;
  ruleLabel: string;
  pairs: string[];
  commitUrl: string;
}): string {
  const chip = (t: string) =>
    `<span style="display:inline-block;background:#EFE7D6;color:#3A2A1B;font-family:ui-monospace,Menlo,monospace;font-size:13px;padding:6px 10px;border-radius:8px;margin:0 6px 6px 0;">${htmlEsc(t)}</span>`;
  const kicker = (t: string) =>
    `<div style="font-size:11px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:#8B8271;margin:22px 0 8px;">${t}</div>`;
  return (
    `<!doctype html><html><body style="margin:0;padding:0;background:#F5F2EB;">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F5F2EB;padding:32px 12px;"><tr><td align="center">` +
    `<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#ffffff;border:1px solid #E7DFD0;border-radius:16px;overflow:hidden;">` +
    `<tr><td style="background:#13273F;padding:18px 28px;">` +
    `<span style="font-family:-apple-system,'Segoe UI',Inter,sans-serif;font-weight:800;font-size:17px;color:#F5F2EB;">Scout</span>` +
    `<span style="font-family:-apple-system,'Segoe UI',Inter,sans-serif;font-size:11px;font-weight:600;letter-spacing:.12em;text-transform:uppercase;color:#8496B4;float:right;line-height:24px;">${
      o.positive ? "Learned from your replies" : "Learned from your feedback"
    }</span></td></tr>` +
    `<tr><td style="padding:28px;font-family:-apple-system,'Segoe UI',Inter,sans-serif;color:#4a4336;font-size:14.5px;line-height:1.65;">` +
    `<h1 style="margin:0 0 6px;font-size:22px;line-height:1.25;color:#3A2A1B;letter-spacing:-.01em;">${htmlEsc(o.title)}</h1>` +
    `<p style="margin:0;color:#8B8271;font-size:13px;">${
      o.positive
        ? "Scout noticed what's getting you replies and adjusted to chase more of it."
        : "Scout noticed a pattern in the finds you pass on and adjusted itself to match."
    }</p>` +
    kicker("What it learned") +
    `<p style="margin:0;">${htmlEsc(o.learned)}</p>` +
    (o.aside
      ? `<p style="margin:10px 0 0;padding:12px 14px;background:#F9F5EE;border:1px solid #E7DFD0;border-radius:10px;font-size:13px;color:#57503f;">${htmlEsc(o.aside)}</p>`
      : "") +
    (o.pairs.length
      ? kicker("What actually changed") +
        `<div style="margin:0 0 6px;font-size:12.5px;color:#8B8271;">${htmlEsc(o.ruleLabel)}</div><div>` +
        o.pairs.map(chip).join("") +
        `</div>`
      : "") +
    kicker("Nothing you need to do") +
    `<p style="margin:0;">Keep approving and passing on finds — Scout keeps calibrating to your taste. If results ever feel off, just say so.</p>` +
    `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:26px 0 4px;"><tr>` +
    `<td><a href="https://scout-source.com/app" style="display:inline-block;background:#13273F;color:#ffffff;text-decoration:none;font-weight:700;font-size:13.5px;padding:11px 20px;border-radius:9px;font-family:-apple-system,'Segoe UI',Inter,sans-serif;">View the change log</a></td>` +
    `<td style="padding-left:14px;"><a href="${htmlEsc(o.commitUrl)}" style="color:#5A4331;font-size:13px;font-weight:600;">Technical commit ↗</a></td>` +
    `</tr></table>` +
    `</td></tr>` +
    `<tr><td style="padding:16px 28px;border-top:1px solid #E7DFD0;font-family:-apple-system,'Segoe UI',Inter,sans-serif;font-size:11.5px;color:#8B8271;">The full before/after rule text lives in Scout → Dashboard → “Tune the search algorithm” → Change log.</td></tr>` +
    `</table></td></tr></table></body></html>`
  );
}


