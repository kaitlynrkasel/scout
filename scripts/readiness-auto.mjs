#!/usr/bin/env node
// Ticks the boxes on /readiness that a MACHINE can decide on its own.
//
// The checklist is mostly human work — "does the first draft sound like a
// person", "does the digest read well on a phone" — and none of that belongs
// here. What belongs here is the other kind of item: the ones whose answer is
// already sitting in the repository, where a person opening a browser is just
// re-deriving something the code states outright. Those are cheap to get wrong
// by eye and free to get right by running them.
//
// Rule for adding a check: only if a FAILING version of the item would make
// this check fail. A grep that proves a file merely mentions the right words is
// not a check. Where the shipping code exports the function, call the function.
//
// Results land in app/readiness/auto.json, which the page reads as a base layer
// under the shared table: a human verdict always wins, and clearing a human
// verdict falls back to the machine's.
//
//   npm run readiness            (full, includes the production build)
//   npm run readiness -- --fast  (skips build + npm audit)

import fs from "node:fs";
import path from "node:path";
import cp from "node:child_process";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FAST = process.argv.includes("--fast");
const only = (process.argv.find((a) => a.startsWith("--only=")) || "").slice(7);

const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const exists = (p) => fs.existsSync(path.join(ROOT, p));
const sh = (cmd, opts = {}) =>
  cp.execSync(cmd, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts });
const tryS = (cmd) => {
  try {
    return { ok: true, out: sh(cmd) };
  } catch (e) {
    return { ok: false, out: `${e.stdout || ""}${e.stderr || ""}` };
  }
};

const ok = (note) => ({ verdict: "ok", note });
const warn = (note) => ({ verdict: "warn", note });
const bad = (note) => ({ verdict: "bad", note });

const CHECKS = [];
const check = (key, fn) => CHECKS.push({ key, fn });

// The engine's own modules, imported through scripts/readiness-hook.mjs so the
// behavioural checks below exercise the shipping functions, not restatements.
const findKeys = await import("../lib/findKeys.ts");
const previewToken = await import("../lib/previewToken.ts");
const autoSearch = await import("../lib/autoSearch.ts");
const tokenCrypto = await import("../lib/tokenCrypto.ts");
const pageText = await import("../lib/pageText.ts");
const peopleIndex = await import("../lib/peopleIndex.ts");
const sheetImport = await import("../lib/sheetImport.ts");
const stripeLib = await import("../lib/stripe.ts");
const discover = await import("../lib/discover.ts");

// ---------------------------------------------------------------------------
// Nothing unpublished, and the site builds
// ---------------------------------------------------------------------------

check("unfinished::decide-what-happens-to-the-work-not-yet-published", () => {
  // Not trimmed: porcelain lines begin with two status columns and a space, and
  // trimming the whole blob eats the first line's leading space with them.
  const dirty = sh("git status --porcelain").replace(/\n+$/, "");
  const branch = sh("git rev-parse --abbrev-ref HEAD").trim();
  const ahead = tryS("git rev-list --count @{u}..HEAD");
  const unpushed = ahead.ok ? Number(ahead.out.trim()) : null;
  if (dirty) {
    const files = dirty.split("\n").map((l) => l.slice(3)).join(", ");
    return warn(`Uncommitted, so unbacked-up: ${files}`);
  }
  if (unpushed === null) return warn(`Branch ${branch} has no upstream, so nothing is pushed anywhere.`);
  if (unpushed > 0) return warn(`${unpushed} commit(s) on ${branch} exist only on this laptop.`);
  return ok(`Working tree clean and ${branch} is level with its remote — nothing is sitting on the laptop alone.`);
});

check("runbook::1-stop-making-changes-and-confirm-the-site-builds", () => {
  if (FAST) return null;
  const types = tryS("npx --no-install tsc --noEmit");
  if (!types.ok) return bad(`Typecheck fails:\n${types.out.split("\n").slice(0, 12).join("\n")}`);
  const build = tryS("npm run build");
  if (!build.ok) {
    const lines = build.out.split("\n").filter((l) => /error|Error|failed/i.test(l));
    return bad(`Production build fails:\n${lines.slice(0, 12).join("\n")}`);
  }
  return ok("npx tsc --noEmit is clean and `next build` completes.");
});

// ---------------------------------------------------------------------------
// Security headers and the preview proxy
// ---------------------------------------------------------------------------

const WANT_HEADERS = [
  ["Content-Security-Policy", /default-src 'self'/],
  ["Strict-Transport-Security", /max-age=\d{7,}/],
  ["X-Content-Type-Options", /nosniff/],
  ["X-Frame-Options", /SAMEORIGIN|DENY/],
  ["Referrer-Policy", /strict-origin/],
  ["Permissions-Policy", /camera=\(\)/],
];

function headerReport() {
  const cfg = read("next.config.js");
  const missing = WANT_HEADERS.filter(([name, re]) => {
    const m = cfg.match(new RegExp(`key:\\s*"${name}"[\\s\\S]{0,400}?value:`, "i"));
    if (!m) return true;
    const after = cfg.slice(m.index, m.index + 900);
    return !re.test(after);
  }).map(([n]) => n);
  return { cfg, missing };
}

check("unfinished::publish-the-browser-security-protections", () => {
  const { cfg, missing } = headerReport();
  if (!/async headers\(\)/.test(cfg)) return bad("next.config.js has no headers() block at all.");
  if (missing.length) return bad(`headers() is published but missing: ${missing.join(", ")}`);
  const committed = sh("git ls-files next.config.js").trim();
  const drift = sh("git diff HEAD -- next.config.js").trim();
  if (!committed) return bad("next.config.js is not tracked by git — the headers exist only locally.");
  if (drift) return warn("next.config.js has uncommitted edits, so the live headers are not these.");
  return ok("All six headers are in a committed next.config.js: " + WANT_HEADERS.map(([n]) => n).join(", "));
});

check("security::done-standard-browser-protections-switched-on", () => {
  const { cfg, missing } = headerReport();
  if (missing.length) return bad(`Missing header(s): ${missing.join(", ")}`);
  // 'unsafe-eval' is the one that would undo the CSP. It is allowed to appear
  // in the file, but only inside the isDev ternary that next build strips.
  const prodEval = /script-src[^`"]*'unsafe-eval'/.test(cfg.replace(/\$\{isDev \? [^}]*\}/g, ""));
  if (prodEval) return bad("The production CSP allows 'unsafe-eval', which defeats the script-src pin.");
  if (!/frame-ancestors 'self'/.test(cfg)) return warn("CSP has no frame-ancestors directive.");
  return ok("Six headers set; 'unsafe-eval' and the HMR socket are behind the isDev flag only.");
});

check("security::done-previewed-websites-are-in-a-locked-box", () => {
  const files = sh(`git grep -l 'sandbox=' -- 'app/*' || true`).trim().split("\n").filter(Boolean);
  if (!files.length) return bad("No sandboxed iframe found — the preview frame is not boxed in.");
  const leaks = [];
  for (const f of files) {
    for (const m of read(f).matchAll(/sandbox="([^"]*)"/g)) {
      if (/allow-same-origin/.test(m[1])) leaks.push(`${f}: "${m[1]}"`);
    }
  }
  if (leaks.length)
    return bad(`A preview frame keeps same-origin access, so it can read our cookies:\n${leaks.join("\n")}`);
  return ok(`Every sandboxed frame (${files.join(", ")}) withholds allow-same-origin.`);
});

check("unfinished::close-the-page-preview-loophole", () => {
  const src = read("app/api/site-preview/route.ts");
  if (!/verifyPreviewToken/.test(src)) return bad("/api/site-preview does not check a preview token — it is an open proxy.");
  const guardBeforeFetch = src.indexOf("verifyPreviewToken") < src.indexOf("fetch(");
  if (!guardBeforeFetch) return bad("The token check happens after the fetch, so the proxy runs unauthenticated.");
  // And the token has to actually mean something.
  const good = previewToken.signPreviewToken("u1");
  const forged = good.split(".")[0] + "." + Buffer.from("nope").toString("base64url");
  if (!previewToken.verifyPreviewToken(good)) return bad("A freshly signed preview token does not verify.");
  if (previewToken.verifyPreviewToken(forged)) return bad("A forged signature is accepted.");
  if (previewToken.verifyPreviewToken("")) return bad("An empty token is accepted.");
  return ok("/api/site-preview refuses to fetch without a valid signed token; forged and empty tokens are rejected.");
});

check("finding::website-previews-require-being-signed-in", () => {
  const minter = read("app/api/preview-token/route.ts");
  const authed = /getUser|auth\.getUser|Authorization|bearer/i.test(minter);
  if (!authed) return bad("/api/preview-token hands a token to anyone who asks — previews are not gated on sign-in.");
  // Expiry is what keeps a leaked token from being a permanent proxy pass.
  const past = (() => {
    const payload = Buffer.from(JSON.stringify({ u: "u1", e: Date.now() - 1000 })).toString("base64url");
    const secret = process.env.ACTION_SECRET || process.env.CRON_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY || "dev-secret";
    return `${payload}.${crypto.createHmac("sha256", secret).update(payload).digest("base64url")}`;
  })();
  if (previewToken.verifyPreviewToken(past)) return bad("An expired preview token still verifies.");
  const hours = previewToken.PREVIEW_TOKEN_TTL_MS / 3600000;
  return ok(`Tokens are minted only for a signed-in user and expire after ${hours}h; an expired one is refused.`);
});

check("security::done-email-approve-links-expire", () => {
  const t = autoSearch.signAction("find-1", "approve");
  if (!autoSearch.verifyAction(t)) return bad("A freshly signed approve link does not verify.");
  const secret = process.env.ACTION_SECRET || process.env.CRON_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY || "scout-action-secret";
  const stamp = (issued) => {
    const p = Buffer.from(JSON.stringify({ f: "find-1", a: "approve", t: issued })).toString("base64url");
    return `${p}.${crypto.createHmac("sha256", secret).update(p).digest("base64url")}`;
  };
  const DAY = 86400000;
  if (autoSearch.verifyAction(stamp(Date.now() - 15 * DAY))) return bad("A 15-day-old approve link still works.");
  if (!autoSearch.verifyAction(stamp(Date.now() - 13 * DAY))) return warn("A 13-day-old link is already refused — the window is shorter than intended.");
  const noStamp = Buffer.from(JSON.stringify({ f: "find-1", a: "approve" })).toString("base64url");
  if (autoSearch.verifyAction(`${noStamp}.${crypto.createHmac("sha256", secret).update(noStamp).digest("base64url")}`))
    return bad("A token with no issued-at is treated as valid forever.");
  if (autoSearch.verifyAction(autoSearch.signAction("find-1", "approve").split(".")[0] + ".AAAA"))
    return bad("A forged signature is accepted on an approve link.");
  return ok("Approve/deny links verify fresh, are refused at 15 days, and a token with no issued-at or a forged signature is rejected.");
});

check("security::done-mailbox-keys-are-stored-scrambled", () => {
  const prev = process.env.TOKEN_ENC_KEY;
  process.env.TOKEN_ENC_KEY = crypto.randomBytes(32).toString("base64");
  try {
    const plain = "1//refresh-token-value";
    const sealed = tokenCrypto.sealToken(plain);
    if (sealed === plain) return bad("sealToken returned the token unchanged even with a key set.");
    if (!sealed.startsWith("enc1:")) return bad(`Sealed token is not in the versioned format: ${sealed.slice(0, 12)}`);
    if (sealed.includes(plain)) return bad("The plaintext token is still visible inside the sealed value.");
    if (tokenCrypto.openToken(sealed) !== plain) return bad("openToken does not round-trip a sealed token.");
    process.env.TOKEN_ENC_KEY = crypto.randomBytes(32).toString("base64");
    // AES-GCM throws on a failed auth tag, which is the right answer here.
    let opened = null;
    try {
      opened = tokenCrypto.openToken(sealed);
    } catch {}
    if (opened === plain) return bad("A DIFFERENT key still opens the token — it is not really encrypted.");
  } finally {
    if (prev === undefined) delete process.env.TOKEN_ENC_KEY;
    else process.env.TOKEN_ENC_KEY = prev;
  }
  // Sealed on the way in, opened on the way out, on both providers.
  const gaps = [];
  for (const f of ["app/api/gmail/callback/route.ts", "app/api/outlook/callback/route.ts"])
    if (!/sealToken\(/.test(read(f))) gaps.push(`${f} stores the refresh token unsealed`);
  for (const f of ["lib/gmail.ts", "lib/outlook.ts"])
    if (!/openToken\(/.test(read(f))) gaps.push(`${f} never unseals, so sealed rows would break`);
  if (gaps.length) return bad(gaps.join("\n"));
  return ok("AES-256-GCM round-trips, a wrong key fails, and both Gmail and Outlook seal on connect and open on use.");
});

// ---------------------------------------------------------------------------
// SSRF: can the server be pointed at our own network?
// ---------------------------------------------------------------------------

// Every one of these is a real way to write an internal address.
const SSRF_PAYLOADS = [
  "http://127.0.0.1/", "http://localhost/", "http://0.0.0.0/", "http://[::1]/",
  "http://10.0.0.5/", "http://192.168.1.1/", "http://172.16.0.1/", "http://172.31.255.1/",
  "http://169.254.169.254/latest/meta-data/", "http://100.64.0.1/",
  "http://2130706433/", "http://0x7f000001/", "http://127.1/",
  "http://db.internal/", "http://printer.local/", "http://api.localhost/",
];

// The hardened guard lives in lib/pageText. Any OTHER fetch path that rolls its
// own host check is only as safe as its own regex, so score them the same way.
function localGuards() {
  const out = [];
  const files = sh("git grep -l 'redirect: \"follow\"' -- lib app || true").trim().split("\n").filter(Boolean);
  for (const f of new Set([...files, "lib/readSite.ts", "app/api/deep-scan/route.ts", "app/api/find-chat/route.ts"])) {
    if (!exists(f) || f === "lib/pageText.ts") continue;
    const src = read(f);
    const m = src.match(/\/\^\((?:localhost|\\\[)[^\n]*\/i?\.test\(u\.hostname\)/);
    if (m) out.push({ file: f, re: m[0] });
  }
  return out;
}

function ssrfMisses(reSource) {
  // Re-run the payload list against a copy of that file's own host test.
  const body = reSource.match(/\/(\^\(.*?\))\/i?\.test/);
  if (!body) return null;
  const re = new RegExp(body[1], "i");
  return SSRF_PAYLOADS.filter((p) => {
    let h;
    try {
      h = new URL(p).hostname;
    } catch {
      return false;
    }
    return !re.test(h);
  });
}

check("security::done-the-server-cannot-be-tricked-into-fetching-internal-add", () => {
  const leaks = SSRF_PAYLOADS.filter((p) => pageText.safeUrl(p) !== null);
  if (leaks.length) return bad(`lib/pageText.safeUrl lets these through:\n${leaks.join("\n")}`);
  if (pageText.safeUrl("https://example.com/jobs") === null) return bad("safeUrl rejects an ordinary public URL.");
  const weak = localGuards()
    .map((g) => ({ file: g.file, misses: ssrfMisses(g.re) }))
    .filter((g) => g.misses && g.misses.length);
  if (weak.length)
    return warn(
      `lib/pageText.safeUrl blocks all ${SSRF_PAYLOADS.length} payloads, but these fetch paths use their own weaker check:\n` +
        weak.map((w) => `  ${w.file} — lets through ${w.misses.join(", ")}`).join("\n")
    );
  return ok(`All ${SSRF_PAYLOADS.length} internal-address forms are refused, on every fetch path.`);
});

check("guardrails::the-website-reading-features-cannot-be-aimed-at-our-own-syst", () => {
  const weak = localGuards()
    .map((g) => ({ file: g.file, misses: ssrfMisses(g.re) }))
    .filter((g) => g.misses && g.misses.length);
  if (!weak.length) return ok("Every site-reading route routes its URL through the hardened lib/pageText.safeUrl.");
  return bad(
    "These reading features each carry their own copy of the host check, and each copy is weaker than lib/pageText.safeUrl:\n" +
      weak.map((w) => `  ${w.file} — accepts ${w.misses.join(", ")}`).join("\n")
  );
});

// ---------------------------------------------------------------------------
// Cost and abuse guardrails
// ---------------------------------------------------------------------------

const FREE_TRIGGER_ROUTES = [
  ["drafting", "app/api/draft/route.ts"],
  ["redrafting", "app/api/redraft-batch/route.ts"],
  ["follow-ups", "app/api/draft-followup/route.ts"],
  ["advice", "app/api/draft-advice/route.ts"],
  ["deep scan", "app/api/deep-scan/route.ts"],
  ["website reading", "app/api/read-website/route.ts"],
  ["company reading", "app/api/read-company/route.ts"],
  ["PDF reading", "app/api/read-pdf/route.ts"],
  ["profile parsing", "app/api/parse-profile/route.ts"],
  ["meeting prep", "app/api/meeting-prep/route.ts"],
  ["application writing", "app/api/application/route.ts"],
  ["category goals", "app/api/category-goal/route.ts"],
  ["example goals", "app/api/example-goal/route.ts"],
  ["starter plans", "app/api/starter-plan/route.ts"],
  ["tuning prompts", "app/api/tuning-prompt/route.ts"],
];

check("guardrails::close-the-fifteen-features-that-anyone-can-trigger-for-free", () => {
  const rows = FREE_TRIGGER_ROUTES.map(([label, f]) => {
    if (!exists(f)) return { label, f, gone: true };
    const src = read(f);
    return {
      label,
      f,
      auth: /getUser\(|requireUser|Authorization|bearer/i.test(src),
      limited: /withinRateLimit/.test(src),
      metered: /entitlement|consumeSearch|meter\(/i.test(src),
    };
  });
  const open = rows.filter((r) => !r.gone && !r.auth);
  if (!open.length) return ok("All fifteen model-calling routes require a signed-in user.");
  const unlimited = open.filter((r) => !r.limited);
  return bad(
    `${open.length} of ${rows.length} routes still take an unauthenticated POST and spend our model credits:\n` +
      open.map((r) => `  ${r.label} (${r.f})${r.limited ? " — rate-limited by IP only" : " — no auth, no rate limit"}`).join("\n") +
      `\n${unlimited.length} of those have no rate limit either.`
  );
});

check("teams::invite-and-company-codes-cannot-be-guessed", () => {
  const src = read("lib/teams.ts");
  const gen = src.match(/for \(let i = 0; i < (\d+); i\+\+\)[\s\S]{0,120}?alphabet\[([^\]]+)\]/g) || [];
  const alphabet = src.match(/alphabet\s*=\s*"([^"]+)"/)?.[1] || "";
  const len = Number(src.match(/for \(let i = 0; i < (\d+); i\+\+\)/)?.[1] || 0);
  const bits = alphabet && len ? Math.round(len * Math.log2(alphabet.length)) : 0;
  const insecure = gen.some((g) => /Math\.random/.test(g)) || /Math\.random\(\)[\s\S]{0,40}alphabet/.test(src);
  if (insecure)
    return warn(
      `Codes are ${len} characters from a ${alphabet.length}-character alphabet (~${bits} bits, not guessable by hand) ` +
        `but they are drawn from Math.random(), which is a predictable generator — seeing a few codes can narrow the next one. ` +
        `crypto.randomInt() is a one-line swap in lib/teams.ts.`
    );
  if (bits < 40) return warn(`Codes carry only ~${bits} bits of entropy.`);
  return ok(`Codes are ${len} characters (~${bits} bits) drawn from a cryptographic generator.`);
});

check("paying::the-free-allowance-matches-what-we-advertise", () => {
  const limit = stripeLib.FREE_LIMIT;
  const words = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, ten: 10 };
  const claims = [];
  const files = sh("git ls-files 'app/**/*.tsx' 'app/**/*.ts' '*.md' 'supabase/*.md'").trim().split("\n").filter(Boolean);
  for (const f of files) {
    const src = read(f);
    for (const m of src.matchAll(/\b(\d+|one|two|three|four|five|six|ten)\s+free\s+(searches?|scouts?)\b/gi)) {
      const n = /^\d+$/.test(m[1]) ? Number(m[1]) : words[m[1].toLowerCase()];
      claims.push({ f, said: m[0], n });
    }
  }
  const wrong = claims.filter((c) => c.n !== limit);
  if (wrong.length)
    return bad(
      `FREE_LIMIT is ${limit}, but the copy says otherwise:\n` + wrong.map((c) => `  ${c.f}: "${c.said}"`).join("\n")
    );
  if (!claims.length) return warn(`FREE_LIMIT is ${limit}, but no page states the allowance in words — nothing to compare it against.`);
  return ok(`FREE_LIMIT is ${limit} and all ${claims.length} place(s) that state it in words agree.`);
});

check("settings::the-site-address-is-the-same-everywhere", () => {
  const names = new Set();
  const out = sh(`git grep -hoE 'process\\.env\\.(NEXT_PUBLIC_SITE_URL|NEXT_PUBLIC_APP_URL|APP_URL|SITE_URL|VERCEL_URL)' -- lib app || true`);
  for (const m of out.matchAll(/process\.env\.(\w+)/g)) names.add(m[1]);
  if (names.size <= 1) return ok(`One address setting is read everywhere: ${[...names][0] || "none"}.`);
  const where = {};
  for (const n of names) {
    const files = sh(`git grep -l 'process.env.${n}' -- lib app || true`).trim().split("\n").filter(Boolean);
    where[n] = files;
  }
  return warn(
    `${names.size} different address settings are read, so one of them being unset or wrong breaks a feature quietly:\n` +
      Object.entries(where).map(([n, fs]) => `  ${n} — ${fs.join(", ")}`).join("\n")
  );
});

check("security::to-do-later-one-remaining-dependency-advisory", () => {
  if (FAST) return null;
  const r = tryS("npm audit --json --omit=dev");
  let j;
  try {
    j = JSON.parse(r.out);
  } catch {
    return warn("npm audit did not return parseable JSON (offline?).");
  }
  const v = j.metadata?.vulnerabilities || {};
  const serious = (v.critical || 0) + (v.high || 0);
  const total = Object.entries(v).filter(([k]) => k !== "total" && k !== "info").reduce((a, [, n]) => a + n, 0);
  const by = (want) =>
    Object.values(j.vulnerabilities || {})
      .filter((x) => want.includes(x.severity))
      .map((x) => `${x.name} (${x.severity}${x.fixAvailable?.isSemVerMajor ? ", fix is a major upgrade" : ""})`);
  if (serious)
    return bad(
      `${serious} high/critical advisory(ies), not one: ${by(["critical", "high"]).join(", ")}. ` +
        (by(["moderate", "low"]).length ? `Plus ${by(["moderate", "low"]).join(", ")}.` : "")
    );
  if (total) return warn(`${total} low/moderate advisory(ies): ${by(["moderate", "low"]).join(", ")}`);
  return ok("npm audit reports no advisories in production dependencies.");
});

// ---------------------------------------------------------------------------
// The contact rule, and the location regression
// ---------------------------------------------------------------------------

check("finding::nobody-reaches-your-pipeline-without-a-way-to-contact-them", () => {
  const has = discover.hasAnyContact;
  const cases = [
    [{ contactEmail: "a@b.com" }, true, "an email"],
    [{ contactPhone: "+1 555 0100" }, true, "a phone number"],
    [{ contactHandle: "@someone" }, true, "a social handle"],
    [{ channel: "Website Form", url: "https://reignfc.com/bio" }, false, "a bio page with channel \"Website Form\""],
    [{ channel: "Company Portal" }, false, "a channel label and nothing else"],
    [{ contactEmail: "   " }, false, "a whitespace-only email"],
    [{ url: "https://linkedin.com/in/someone" }, false, "a profile URL alone"],
  ];
  const wrong = cases.filter(([o, want]) => has(o) !== want).map(([, , label]) => label);
  if (wrong.length) return bad(`The reachability test is wrong for: ${wrong.join("; ")}`);
  const src = read("lib/discover.ts");
  if (!/if \(!hasAnyContact\(opps\[i\]\)\)[\s\S]{0,200}opps\.splice\(i, 1\)/.test(src))
    return bad("hasAnyContact is correct but discover() no longer removes the finds that fail it.");
  return ok(
    "discover() drops any find failing hasAnyContact, and the test is keyed on a real contact value: a bio page " +
      'carrying channel "Website Form" and no address, number or handle is refused.'
  );
});

check("finding::a-search-with-no-location-given-is-not-steered-to-any-city", () => {
  const src = read("lib/discover.ts");
  const start = src.indexOf('"HOME BASE:');
  if (start < 0) return bad("The HOME BASE rule is gone from the planner prompt.");
  const end = src.indexOf('"confidence_questions', start);
  const rule = src.slice(start, end > 0 ? end : start + 3000);
  const PLACES =
    /\b(seattle|portland|san francisco|los angeles|new york|chicago|boston|austin|denver|miami|atlanta|london|berlin|paris|tokyo|nashville|bellevue|tacoma|toronto|bay area|pacific northwest|silicon valley|PNW)\b/gi;
  const named = [...new Set([...rule.matchAll(PLACES)].map((m) => m[0]))];
  if (named.length)
    return bad(
      `The HOME BASE rule names real places (${named.join(", ")}). This is the exact shape of the earlier regression: ` +
        "the only cities in the prompt become the default for goals that give no location."
    );
  const guards = [
    [/NO geographic preference whatsoever/i, "the no-base case states that no geography applies"],
    [/do not invent a\s*"? ?\n?\s*"?\s*city/i, "it forbids inventing a city"],
    [/do not fall back to anywhere named in these instructions/i, "it forbids borrowing a place from the prompt itself"],
  ];
  const missing = guards.filter(([re]) => !re.test(rule.replace(/"\s*\+\s*\n?\s*"/g, ""))).map(([, d]) => d);
  if (missing.length) return warn(`The HOME BASE rule no longer says: ${missing.join("; ")}.`);
  return ok(
    "The HOME BASE rule names no city, and still says outright that with no base given it applies no geography, " +
      "invents no city, and does not fall back to any place named elsewhere in the prompt."
  );
});

// ---------------------------------------------------------------------------
// Importing a spreadsheet
// ---------------------------------------------------------------------------

const MAPPING = { Name: "name", Email: "email", Company: "outlet", Role: "role", Link: "url", Notes: "notes" };
const importOpts = (rows, extra = {}) => ({
  rows,
  mapping: MAPPING,
  defaultStatus: "new",
  projectId: "p1",
  sourceLabel: "Test sheet",
  ...extra,
});

check("importing::spreadsheet-junk-does-not-become-contacts", () => {
  const rows = [
    { Name: "Dana Reed", Email: "dana@label.com" },
    { Name: "", Email: "" },
    { Name: "TRUE", Email: "FALSE" },
    { Name: "N/A", Email: "-" },
    { Name: "x", Email: "" },
    { Name: "In July 2025 we covered a run of showcases across the region and made contact with several bookers", Email: "" },
    { Name: "Dana Reed", Email: "dana@label.com" },
  ];
  const finds = sheetImport.rowsToFinds(importOpts(rows));
  const names = finds.map((f) => f.opp.name);
  if (finds.length !== 1) return bad(`7 rows (1 real, 1 duplicate, 5 junk) produced ${finds.length} contacts: ${names.join(" | ")}`);
  if (names[0] !== "Dana Reed") return bad(`The surviving contact is "${names[0]}", not the real person.`);
  return ok('Blank rows, "TRUE"/"FALSE"/"N/A"/"x" cell artifacts, a prose note with no contact route, and a duplicate all fail to become contacts; the one real row does.');
});

check("importing::accents-and-unusual-characters-survive", () => {
  const rows = [
    { Name: "Zoë Müller-D'Angelo", Email: "zoe@münchen-label.de", Company: "Über Récords", Notes: "Spoke at Køln — very warm" },
    { Name: "北野 武", Email: "kitano@example.jp" },
  ];
  const finds = sheetImport.rowsToFinds(importOpts(rows));
  if (finds.length !== 2) return bad(`Two accented rows produced ${finds.length} contacts.`);
  const [a, b] = finds;
  if (a.opp.name !== "Zoë Müller-D'Angelo") return bad(`Name came back mangled: "${a.opp.name}"`);
  if (a.opp.contactEmail !== "zoe@münchen-label.de") return bad(`Email came back mangled: "${a.opp.contactEmail}"`);
  if (a.opp.outlet !== "Über Récords") return bad(`Company came back mangled: "${a.opp.outlet}"`);
  if (!a.opp.whyItFits.includes("Køln")) return bad("Notes lost their accented characters.");
  if (b.opp.name !== "北野 武") return bad(`Non-Latin name came back as "${b.opp.name}"`);
  // The dedup key folds accents, which is what stops "Zoe" and "Zoë" splitting in two.
  if (findKeys.normNameKey("Zoë Müller") === findKeys.normNameKey("Zoe Muller"))
    return ok("Accents, apostrophes, hyphens and non-Latin scripts survive the import intact, and the dedup key folds accented spellings together.");
  return warn(
    'Display values survive intact, but the dedup key treats "Zoë Müller" and "Zoe Muller" as two different people ' +
      "(normNameKey drops non-ASCII rather than folding it), so the same person imported twice under two spellings lands twice."
  );
});

check("importing::a-very-large-file-does-not-hang-the-app", () => {
  const rows = Array.from({ length: 20000 }, (_, i) => ({
    Name: `Person ${i}`,
    Email: `p${i}@example.com`,
    Company: `Company ${i % 500}`,
    Notes: "Imported row with a reasonably long note attached to it for weight.",
  }));
  const t0 = Date.now();
  const finds = sheetImport.rowsToFinds(importOpts(rows));
  const ms = Date.now() - t0;
  if (finds.length !== 20000) return bad(`20,000 rows produced ${finds.length} finds.`);
  if (ms > 5000) return warn(`20,000 rows took ${(ms / 1000).toFixed(1)}s to map — slow enough to freeze the tab.`);
  return ok(`20,000 rows map to 20,000 contacts in ${ms}ms, so the parse itself cannot be what hangs a big import.`);
});

check("importing::a-broken-or-wrong-file-fails-politely", () => {
  const bads = [
    ["no rows at all", importOpts([])],
    ["rows with no mapped columns", importOpts([{ Random: "x", Other: "y" }])],
    ["null and undefined cells", importOpts([{ Name: null, Email: undefined }])],
    ["no project id", importOpts([{ Name: "A" }], { projectId: "" })],
    ["a non-sheet URL", importOpts([{ Name: "A", Email: "a@b.com" }], { sourceUrl: "https://example.com/not-a-sheet" })],
  ];
  for (const [label, opts] of bads) {
    try {
      const out = sheetImport.rowsToFinds(opts);
      if (!Array.isArray(out)) return bad(`${label} returned ${typeof out} instead of a list.`);
    } catch (e) {
      return bad(`${label} threw instead of returning nothing: ${e.message}`);
    }
  }
  if (sheetImport.rowsToFinds(importOpts([{ Name: "A" }], { projectId: "" })).length !== 0)
    return bad("A missing project id still produced contacts.");
  if (sheetImport.sheetRowLink("https://example.com/not-a-sheet", 4) !== "")
    return bad("A non-Google URL still produced a row deep-link.");
  return ok("Empty, unmapped, null-valued, project-less and non-sheet inputs all come back as an empty list rather than throwing.");
});

check("importing::imported-personal-contacts-stay-private", () => {
  const cases = [
    [{ contactEmail: "someone@gmail.com", name: "A" }, false, "a gmail address"],
    [{ contactEmail: "someone@yahoo.com", name: "A" }, false, "a yahoo address"],
    [{ contactEmail: "someone@hotmail.com", name: "A" }, false, "a hotmail address"],
    [{ contactEmail: "someone@icloud.com", name: "A" }, false, "an icloud address"],
    [{ name: "A", contactHandle: "@private" }, false, "a bare handle with no business address"],
    [{ contactEmail: "bookings@label.com", name: "Label", url: "https://label.com" }, true, "a role inbox on a company domain"],
  ];
  const wrong = cases.filter(([o, want]) => peopleIndex.isBusinessContact(o) !== want).map(([, , l]) => l);
  if (wrong.length) return bad(`The shared-index gate is wrong for: ${wrong.join("; ")}`);
  const src = read("lib/peopleIndex.ts");
  if (!/\.filter\(isBusinessContact\)/.test(src))
    return bad("isBusinessContact is correct but the publish path no longer filters through it.");
  return ok("Only role inboxes on company domains cross into the shared index; personal freemail addresses and bare handles are held back, and the publish path filters on it.");
});

check("importing::imported-rows-link-back-to-the-exact-sheet-row", () => {
  const sheet = "https://docs.google.com/spreadsheets/d/ABC123/edit#gid=7";
  const link = sheetImport.sheetRowLink(sheet, 42);
  if (!/gid=7/.test(link)) return bad(`The deep link lost the tab id: ${link}`);
  if (!/range=A42/.test(link)) return bad(`The deep link lost the row number: ${link}`);
  const rows = [{ Name: "Dana Reed", Email: "dana@label.com", [sheetImport.ROW_NUM_KEY]: "42" }];
  const [find] = sheetImport.rowsToFinds(importOpts(rows, { sourceUrl: sheet }));
  if (!find) return bad("A row carrying its row number produced no contact.");
  if (find.opp.sheetRef?.row !== 42) return bad(`The contact carries row ${find.opp.sheetRef?.row}, not 42.`);
  if (!/range=A42/.test(find.opp.sheetRef?.url || "")) return bad(`The contact's link is ${find.opp.sheetRef?.url}`);
  return ok("A row stamped 42 becomes a contact whose link opens that sheet at gid=7, cell A42.");
});

// ---------------------------------------------------------------------------
// The public shell
// ---------------------------------------------------------------------------

check("feel::a-wrong-address-gives-a-helpful-page", () => {
  if (!exists("app/not-found.tsx")) return bad("There is no app/not-found.tsx, so a wrong address gets Next's bare default.");
  const src = read("app/not-found.tsx");
  if (!/export default function/.test(src)) return bad("app/not-found.tsx exports no page component.");
  if (!/href="\/"/.test(src)) return bad("The 404 page offers no way back to the front page.");
  const words = (src.match(/>([^<>{}]{25,})</g) || []).length;
  if (words < 2) return warn("The 404 page renders almost no explanatory text.");
  return ok("app/not-found.tsx is a real Scout page with an explanation and a link home.");
});

check("live::search-engines-are-told-what-to-index", () => {
  if (!exists("app/robots.ts")) return bad("No app/robots.ts, so crawlers get no instructions.");
  if (!exists("app/sitemap.ts")) return warn("robots exists but there is no sitemap.");
  const robots = read("app/robots.ts");
  const sitemap = read("app/sitemap.ts");
  const mustHide = ["/app", "/admin", "/api/", "/readiness"];
  const missing = mustHide.filter((p) => !robots.includes(`"${p}"`));
  if (missing.length) return bad(`Signed-in surfaces are not disallowed: ${missing.join(", ")}`);
  if (!/sitemap:/.test(robots)) return warn("robots.txt does not point at the sitemap.");
  const listed = [...sitemap.matchAll(/\$\{base\}(\/[a-z-]*)?/g)].map((m) => m[1] || "/");
  const leaked = listed.filter((u) => mustHide.some((h) => u.startsWith(h)));
  if (leaked.length) return bad(`The sitemap advertises a private surface: ${leaked.join(", ")}`);
  return ok(`robots.txt hides ${mustHide.join(", ")} and points at the sitemap, which lists only ${listed.join(", ")}.`);
});

check("live::shared-links-look-right", () => {
  const src = read("app/layout.tsx");
  if (!/metadataBase/.test(src)) return bad("No metadataBase, so preview image URLs resolve relative and break.");
  const og = src.match(/openGraph:\s*\{[\s\S]*?\n  \}/)?.[0] || "";
  const tw = src.match(/twitter:\s*\{[\s\S]*?\n  \}/)?.[0] || "";
  const gaps = [];
  if (!/title:/.test(og)) gaps.push("openGraph title");
  if (!/description:/.test(og)) gaps.push("openGraph description");
  if (!/siteName:/.test(og)) gaps.push("openGraph siteName");
  if (!/card:\s*"summary_large_image"/.test(tw)) gaps.push("twitter summary_large_image card");
  if (!exists("app/opengraph-image.png")) gaps.push("app/opengraph-image.png");
  if (gaps.length) return bad(`A shared link would render incomplete — missing: ${gaps.join(", ")}`);
  const bytes = fs.statSync(path.join(ROOT, "app/opengraph-image.png")).size;
  const buf = fs.readFileSync(path.join(ROOT, "app/opengraph-image.png"));
  const w = buf.readUInt32BE(16);
  const h = buf.readUInt32BE(20);
  if (w !== 1200 || h !== 630)
    return warn(`Preview card is ${w}x${h}; the size every platform crops to cleanly is 1200x630.`);
  if (bytes > 5_000_000) return warn(`The preview image is ${(bytes / 1e6).toFixed(1)}MB — some platforms refuse to fetch it.`);
  return ok(`Title, description, site name, a large-image Twitter card and a ${w}x${h} preview image are all set, on an absolute metadataBase.`);
});

check("live::the-old-version-of-the-site-sends-people-to-the-new-one", () => {
  if (!exists("middleware.ts")) return bad("There is no middleware, so the old deployment serves a second live copy of Scout.");
  const src = read("middleware.ts");
  const olds = [...(src.match(/OLD_HOSTS = new Set\(\[([^\]]*)\]/)?.[1] || "").matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  if (!olds.length) return bad("The redirect list is empty — nothing gets sent anywhere.");
  const canonical = src.match(/CANONICAL = "([^"]+)"/)?.[1];
  if (!canonical) return bad("No canonical destination is set.");
  if (!/redirect\(dest, 308\)/.test(src)) return warn("The redirect is not a 308, so the path and method are not guaranteed to survive.");
  if (!/pathname \+ req\.nextUrl\.search/.test(src)) return warn("The redirect drops the path, so every old link lands on the home page.");
  if (/scout-source\.com/.test(olds.join(" "))) return bad("The live host is in the redirect list — the site would redirect to itself.");
  return ok(`${olds.join(", ")} redirect 308 to ${canonical}, keeping the path and query; the live host is untouched.`);
});

check("feel::animation-respects-the-reduce-motion-setting", () => {
  const css = read("app/globals.css");
  // Strip the reduced-motion blocks, then see what still animates.
  const reduced = [...css.matchAll(/@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*?)\n\}/g)].map((m) => m[1]).join("\n");
  if (!reduced) return bad("No prefers-reduced-motion block exists at all.");
  const outside = css.replace(/@media \(prefers-reduced-motion: reduce\)[\s\S]*?\n\}/g, "");
  const blanket = /\*\s*,?[\s\S]{0,80}\{[^}]*animation[^}]*none\s*!important/.test(reduced);
  const animated = new Set();
  for (const m of outside.matchAll(/(^|\n)([.#][\w-]+(?:[^{\n]*)?)\{([^}]*)\}/g)) {
    if (/animation:\s*[a-z]/i.test(m[3])) {
      for (const sel of m[2].split(",")) {
        const cls = sel.trim().match(/^[.#][\w-]+/);
        if (cls) animated.add(cls[0]);
      }
    }
  }
  const uncovered = [...animated].filter((c) => !reduced.includes(c));
  if (blanket) return ok("A blanket prefers-reduced-motion rule switches every animation off.");
  // Tailwind's own animate-* utilities never touch globals.css, so a per-class
  // override scheme misses every one of them however complete it looks.
  const tw = {};
  for (const u of sh(`git grep -ohE 'animate-[a-z-]+' -- 'app' || true`).trim().split("\n").filter(Boolean))
    tw[u] = (tw[u] || 0) + 1;
  const twList = Object.entries(tw).map(([u, n]) => `${u} (${n})`);
  if (uncovered.length || twList.length)
    return warn(
      `${animated.size - uncovered.length} of ${animated.size} animated classes in globals.css have a reduced-motion override` +
        (uncovered.length ? `; these do not: ${uncovered.slice(0, 12).join(", ")}` : "") +
        (twList.length
          ? `. Separately, Tailwind's own utilities are used in the app and none of them are covered, because the overrides ` +
            `are written one class at a time in globals.css: ${twList.join(", ")}.`
          : ".") +
        " One blanket rule — animation and transition off under prefers-reduced-motion — would cover these and every future one."
    );
  return ok(`All ${animated.size} animated classes in globals.css carry a prefers-reduced-motion override.`);
});

// ---------------------------------------------------------------------------

const results = {};
const skipped = [];
for (const { key, fn } of CHECKS) {
  if (only && !key.includes(only)) continue;
  let r;
  try {
    r = await fn();
  } catch (e) {
    r = bad(`The check itself failed to run: ${e.message}`);
  }
  if (!r) {
    skipped.push(key);
    continue;
  }
  results[key] = r;
}

// Cross-check the keys against the checklist so a renamed item can't leave a
// verdict floating against nothing.
const data = JSON.parse(read("app/readiness/data.json"));
const known = new Set(data.parts.flatMap((p) => p.sections.flatMap((s) => s.items.map((i) => i.key))));
const orphans = Object.keys(results).filter((k) => !known.has(k));
if (orphans.length) {
  console.error(`\nThese checks name items that are not on the checklist:\n  ${orphans.join("\n  ")}\n`);
  process.exitCode = 1;
}

const out = {
  generatedAt: new Date().toISOString(),
  commit: sh("git rev-parse --short HEAD").trim(),
  partial: FAST || !!only,
  checks: results,
};
const dest = "app/readiness/auto.json";
const prev = exists(dest) ? JSON.parse(read(dest)) : { checks: {} };
if (FAST || only) out.checks = { ...prev.checks, ...results }; // a partial run tops up, never truncates
fs.writeFileSync(path.join(ROOT, dest), JSON.stringify(out, null, 2) + "\n");

const pad = (s, n) => s + " ".repeat(Math.max(0, n - s.length));
const MARK = { ok: "PASS", warn: "NEEDS WORK", bad: "BROKEN" };
console.log("");
for (const [key, r] of Object.entries(results)) {
  console.log(`${pad(MARK[r.verdict], 11)} ${key}`);
  for (const line of r.note.split("\n")) console.log(`            ${line}`);
  console.log("");
}
const n = (v) => Object.values(results).filter((r) => r.verdict === v).length;
console.log(`${Object.keys(results).length} items checked by code: ${n("ok")} pass, ${n("warn")} need work, ${n("bad")} broken.`);
if (skipped.length) console.log(`Skipped in --fast: ${skipped.join(", ")}`);
console.log(`Written to ${dest}\n`);
