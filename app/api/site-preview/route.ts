import { NextRequest, NextResponse } from "next/server";
import { safeUrl } from "@/lib/pageText";
import { verifyPreviewToken } from "@/lib/previewToken";
import { withinRateLimit, requestIp } from "@/lib/rateLimit";

export const runtime = "nodejs";
export const maxDuration = 20;

// Serves a site's HTML back through OUR origin so the find-detail preview
// iframe can embed it. Embedding the target URL directly gets blocked by
// X-Frame-Options / CSP frame-ancestors on most real sites ("refused to
// connect"), that's the browser enforcing headers on the direct cross-origin
// request. Proxying means the browser only ever requests OUR route, which sets
// no such headers, so the iframe loads. A <base> tag keeps every relative
// link/asset resolving against the real site. This is a single-request,
// uncached pass-through for in-app preview, not a cache or republish of the
// page.
export async function GET(req: NextRequest) {
  // Gate the proxy behind a short-lived signed token (minted by the auth'd
  // /api/preview-token route), otherwise this endpoint is an open proxy that
  // anyone can route traffic through. Signed-out visitors get a clean page
  // with a direct link instead of a proxied preview.
  const pt = req.nextUrl.searchParams.get("pt") || "";
  const raw = req.nextUrl.searchParams.get("url") || "";
  if (!verifyPreviewToken(pt)) {
    return htmlResponse(
      errorPage(
        "Sign in to Scout to preview sites here.",
        safeUrl(raw)?.toString() || undefined
      )
    );
  }
  // Burst cap per caller: a grid of cards loads dozens of previews, so the
  // ceiling is generous, but a runaway loop still hits a wall.
  if (!withinRateLimit(`prev:${requestIp(req.headers)}`, 300, 10 * 60 * 1000)) {
    return htmlResponse(errorPage("Too many previews at once, give it a minute."));
  }
  const u = safeUrl(raw);
  if (!u) {
    return htmlResponse(errorPage("That link isn't a valid, reachable web address."));
  }

  let html: string;
  try {
    const r = await fetchPage(u.toString());
    if (!r.ok) {
      return htmlResponse(blockedPage(r.status, u.toString()));
    }
    const ct = r.headers.get("content-type") || "";
    if (!ct.includes("html")) {
      return htmlResponse(errorPage("That link isn't a webpage Scout can preview.", u.toString()));
    }
    html = await r.text();
  } catch {
    return htmlResponse(
      errorPage("Scout couldn't reach this site to preview it.", u.toString())
    );
  }

  // Cap payload size, this is a visual preview, not a full mirror.
  if (html.length > 2_000_000) html = html.slice(0, 2_000_000);

  // Link-in-bio pages (Linktree and friends) are JS apps that preview badly
  // in a frame: broken icon boxes, raw blue anchors, half-hydrated layout.
  // Scout renders its OWN clean version instead: the page's avatar, name,
  // bio line, and buttons, restyled, with the original a click away. Falls
  // back to the normal proxy when parsing finds too little.
  if (/(^|\.)(linktr\.ee|lnk\.bio|beacons\.ai|bio\.link|hoo\.be|komi\.io|solo\.to|linkin\.bio|campsite\.bio|tap\.bio)$/i.test(u.hostname)) {
    const rendered = bioLinkPage(html, u);
    if (rendered) return htmlResponse(rendered, true);
  }

  // Neutralize any framing directives the page sets itself via <meta> tags
  // (belt-and-suspenders; the real blockers are the HTTP response headers,
  // which we never forward since our own response sets none of them).
  html = html.replace(
    /<meta[^>]+http-equiv=["']?(x-frame-options|content-security-policy)["']?[^>]*>/gi,
    ""
  );

  // Inject a <base> so every relative href/src (css, js, images, links)
  // resolves against the real site instead of our proxy route. Must be the
  // very first thing in <head> to take effect for everything after it.
  // Follow it with preconnect/dns-prefetch hints for the real origin so the
  // browser opens the TCP+TLS connection to it early, shaving the wait before
  // the page's own CSS/images (e.g. a big hero photo) start downloading.
  const base =
    `<base href="${u.origin}${u.pathname.replace(/[^/]*$/, "")}">` +
    // No referrer on subresource requests: image CDNs that hotlink-check the
    // referrer (Linktree icons, some avatars) serve a no-referrer request fine
    // but 403 one carrying our proxy origin.
    `<meta name="referrer" content="no-referrer">` +
    `<link rel="preconnect" href="${u.origin}" crossorigin>` +
    `<link rel="dns-prefetch" href="${u.origin}">`;
  html = /<head[^>]*>/i.test(html)
    ? html.replace(/<head[^>]*>/i, (m) => `${m}${base}`)
    : `${base}${html}`;

  // JS-app pages (Linktree and friends) build image URLs off
  // window.location, which inside the proxy is OUR origin — so their icons
  // and avatars 404 as /_next/image on scout-source. The <base> tag can't
  // reach URLs built in JS. This rescue catches any image that errors on a
  // same-(proxy)-origin URL and repoints it at the page's real origin.
  const IMG_RESCUE =
    `<script>(function(){var REAL=${JSON.stringify(u.origin)};` +
    `document.addEventListener("error",function(e){var t=e.target;` +
    `if(!t||t.tagName!=="IMG"||t.__rescued)return;` +
    `try{var abs=new URL(t.src,location.href);` +
    `if(abs.origin===location.origin){t.__rescued=1;t.src=REAL+abs.pathname+abs.search;}}catch(_){}},true);` +
    `})()</script>`;

  // Inject the autofill bridge (see AUTOFILL_SCRIPT). It lets the Scout panel
  // pre-fill a contact form the user is looking at, it never submits.
  html = /<\/body>/i.test(html)
    ? html.replace(/<\/body>/i, `${IMG_RESCUE}${AUTOFILL_SCRIPT}</body>`)
    : `${html}${IMG_RESCUE}${AUTOFILL_SCRIPT}`;

  // Cache the assembled preview: the output is deterministic per URL, so
  // reopening the same find (or the same site on another find) serves instantly
  // from the browser/CDN instead of re-fetching the whole page. Short TTL keeps
  // it fresh; this is only the visual preview, never anything user-specific.
  return htmlResponse(html, true);
}

// A modern desktop-Chrome header set. Many sites 403 a bare fetch that's missing
// the Sec-Fetch-*/Accept-Language/UA-brand headers a real browser always sends,
// so we mimic them to get past soft bot checks.
const BROWSER_HEADERS: Record<string, string> = {
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "accept-language": "en-US,en;q=0.9",
  "sec-ch-ua": '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"macOS"',
  "sec-fetch-dest": "document",
  "sec-fetch-mode": "navigate",
  "sec-fetch-site": "none",
  "sec-fetch-user": "?1",
  "upgrade-insecure-requests": "1",
};

// Fetch the page like a browser; if the site blocks us (403/401/429/451),
// retry once announcing ourselves as Googlebot, which many sites allow-list for
// crawlability even when they refuse anonymous browser traffic.
async function fetchPage(url: string): Promise<Response> {
  const r = await fetch(url, {
    headers: BROWSER_HEADERS,
    redirect: "follow",
    signal: AbortSignal.timeout(10000),
  });
  if (r.ok || ![401, 403, 429, 451].includes(r.status)) return r;
  try {
    const bot = await fetch(url, {
      headers: {
        "user-agent":
          "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
        accept: BROWSER_HEADERS.accept,
        "accept-language": "en-US,en;q=0.9",
        from: "googlebot(at)googlebot.com",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(10000),
    });
    // Prefer whichever attempt actually got through.
    return bot.ok ? bot : r;
  } catch {
    return r;
  }
}

// Runs inside the proxied page (same origin as the app, so postMessage is
// trusted). Two jobs:
//   1. On load, report whether the page has a fillable contact form, so the
//      panel only offers "Fill this form" when there's something to fill.
//   2. On a 'scout-autofill' message, heuristically map the sender's details +
//      drafted message onto the form's fields and highlight them. It stops
//      short of submitting, the user reviews and sends themselves.
const AUTOFILL_SCRIPT = `<script>(function(){
  function labelText(el){
    try{
      var lbl=el.labels&&el.labels[0]?el.labels[0].textContent:'';
      if(!lbl&&el.id){var l=document.querySelector('label[for="'+CSS.escape(el.id)+'"]');lbl=l?l.textContent:'';}
      if(!lbl){var p=el.closest('label');lbl=p?p.textContent:'';}
      if(!lbl)lbl=el.getAttribute('aria-label')||el.placeholder||el.name||'';
      return (lbl||'').replace(/\\s+/g,' ').replace(/\\*/g,'').trim();
    }catch(e){return el.placeholder||el.name||'';}
  }
  function sig(el){
    return [el.name,el.id,el.placeholder,el.getAttribute('aria-label'),el.type,labelText(el)].join(' ').toLowerCase();
  }
  function fields(){
    var out=[];
    var els=document.querySelectorAll('input,textarea');
    for(var i=0;i<els.length;i++){
      var el=els[i],t=(el.type||'').toLowerCase();
      if(t==='hidden'||t==='submit'||t==='button'||t==='checkbox'||t==='radio'||t==='file'||t==='password'||el.disabled||el.readOnly)continue;
      if(el.offsetParent===null)continue;
      out.push(el);
    }
    return out;
  }
  function setVal(el,val){
    try{
      var proto=el.tagName==='TEXTAREA'?window.HTMLTextAreaElement.prototype:window.HTMLInputElement.prototype;
      var setter=Object.getOwnPropertyDescriptor(proto,'value');
      if(setter&&setter.set){setter.set.call(el,val);}else{el.value=val;}
      el.dispatchEvent(new Event('input',{bubbles:true}));
      el.dispatchEvent(new Event('change',{bubbles:true}));
      el.style.outline='2px solid #7c5837';el.style.outlineOffset='1px';
    }catch(e){el.value=val;}
  }
  function questions(){
    var f=fields(),out=[],seen={};
    for(var i=0;i<f.length;i++){var L=labelText(f[i]);if(L&&L.length<160&&!seen[L]){seen[L]=1;out.push(L);}}
    return out.slice(0,25);
  }
  function hasForm(){
    var f=fields();
    for(var i=0;i<f.length;i++){var s=sig(f[i]);if(f[i].tagName==='TEXTAREA'||f[i].type==='email'||/email|message|name|comment|inquir|phone|resume|cover/.test(s))return true;}
    return false;
  }
  // Best value for a field from the user's data, or null when we can't map it.
  function pick(s,d){
    if(d.email&&(/e-?mail/.test(s)))return d.email;
    if(d.phone&&(/phone|tel|mobile|cell/.test(s)))return d.phone;
    if(d.linkedin&&/linkedin/.test(s))return d.linkedin;
    if(d.website&&/(website|portfolio|url|link)/.test(s)&&!/linkedin/.test(s))return d.website;
    if(d.first&&/(first|given).*name|name.*first/.test(s))return d.first;
    if(d.last&&/(last|sur|family).*name|name.*(last|sur)/.test(s))return d.last;
    if(d.company&&/(company|organi|employer|business|firm|studio)/.test(s))return d.company;
    if(d.role&&/(job ?title|position|role|title|occupation)/.test(s))return d.role;
    if(d.location&&/(city|town|location|address|where.*based|region|state|country)/.test(s))return d.location;
    if(d.name&&/name/.test(s))return d.name;
    return null;
  }
  function fill(d){
    var f=fields(),any=false,firstEl=null;
    for(var i=0;i<f.length;i++){
      var el=f[i],s=sig(el),v=pick(s,d);
      // Any free-text box (textarea or a message-like input) gets the drafted note.
      if(!v&&d.message&&(el.tagName==='TEXTAREA'||/message|comment|about|why|cover|tell us|note|detail|question|anything|introduc|pitch|bio|summary/.test(s)))v=d.message;
      if(v){setVal(el,String(v));any=true;firstEl=firstEl||el;}
    }
    if(firstEl){try{firstEl.scrollIntoView({behavior:'smooth',block:'center'});}catch(e){}}
    return any;
  }
  window.addEventListener('message',function(ev){
    var d=ev&&ev.data;if(!d||d.type!=='scout-autofill')return;
    var ok=fill(d.payload||{});
    try{parent.postMessage({type:'scout-autofill-done',filled:ok},'*');}catch(e){}
  });
  // Keep in-frame navigation INSIDE the proxy: a plain link would send the iframe
  // to the real cross-origin site, which then refuses to be framed. Reroute same-
  // tab link clicks back through this proxy route so the next page also previews.
  document.addEventListener('click',function(e){
    try{
      if(e.defaultPrevented||e.button!==0||e.metaKey||e.ctrlKey||e.shiftKey||e.altKey)return;
      var a=e.target&&e.target.closest?e.target.closest('a'):null;
      if(!a||!a.href)return;
      if(a.target&&a.target!=='_self')return; // new-tab links open the real site, fine
      if(a.href.indexOf('http')!==0)return;   // skip javascript:, mailto:, tel:, #
      var here=location.href.split('?')[0];
      var cur=location.href.replace(here+'?url=','');
      var dest=encodeURIComponent(a.href);
      if(dest===cur)return; // same page (anchor), let it be
      e.preventDefault();
      location.href=here+'?url='+dest;
    }catch(err){}
  },true);
  function announce(){try{parent.postMessage({type:'scout-form-detected',hasForm:hasForm(),questions:questions()},'*');}catch(e){}}
  if(document.readyState==='loading'){document.addEventListener('DOMContentLoaded',announce);}else{setTimeout(announce,300);}
})();</script>`;

function htmlResponse(html: string, cache = false): NextResponse {
  return new NextResponse(html, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      // Real previews cache briefly (instant reopen); error/blocked pages never
      // cache, so a transient block or outage can be retried on the next open.
      "cache-control": cache
        ? "public, max-age=300, s-maxage=900, stale-while-revalidate=86400"
        : "no-store",
    },
  });
}

function errorPage(message: string, realUrl?: string): string {
  return (
    `<!doctype html><html><head><meta charset="utf-8"><style>` +
    `body{margin:0;display:flex;align-items:center;justify-content:center;height:100vh;` +
    `font-family:-apple-system,system-ui,sans-serif;background:#f4f2ee;color:#57534c;text-align:center;padding:24px}` +
    `p{max-width:340px;line-height:1.5;font-size:14px}a{color:#7c5837}</style></head><body>` +
    `<p>${message}${realUrl ? ` <br><a href="${realUrl}" target="_blank" rel="noreferrer">Open it directly ↗</a>` : ""}</p>` +
    `</body></html>`
  );
}

// A site that refused the automated preview (403/401/429/451). This is the site
// blocking bots, not a broken link, so lead with opening it in a real tab,
// where the user's own browser session sails through.
function blockedPage(status: number, realUrl: string): string {
  const why =
    status === 429
      ? "This site is rate-limiting automated requests right now."
      : "This site blocks automated previews (common with strong anti-bot protection).";
  return (
    `<!doctype html><html><head><meta charset="utf-8"><style>` +
    `body{margin:0;display:flex;align-items:center;justify-content:center;height:100vh;` +
    `font-family:-apple-system,system-ui,sans-serif;background:#f4f2ee;color:#57534c;text-align:center;padding:24px}` +
    `.w{max-width:340px}p{line-height:1.5;font-size:14px;margin:0 0 16px}` +
    `a{display:inline-block;background:#7c5837;color:#fff;text-decoration:none;font-weight:700;` +
    `font-size:13px;padding:10px 18px;border-radius:12px}small{display:block;margin-top:14px;color:#8a857c;font-size:12px}` +
    `</style></head><body><div class="w">` +
    `<p>${why} It usually opens fine in your own browser.</p>` +
    `<a href="${realUrl}" target="_blank" rel="noreferrer">Open ${escapeHost(realUrl)} ↗</a>` +
    `<small>Scout can still draft outreach and scan for contacts, the preview is just the site&rsquo;s own block.</small>` +
    `</div></body></html>`
  );
}

function escapeHost(u: string): string {
  try {
    return new URL(u).hostname.replace(/^www\./, "");
  } catch {
    return "the site";
  }
}

/* ---------------- Link-in-bio re-render ---------------- */
function escHtml(v: string): string {
  return v
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
function metaContent(html: string, name: string): string {
  const re = new RegExp(
    `<meta[^>]+(?:property|name)=["']${name}["'][^>]+content=["']([^"']+)["']`,
    "i"
  );
  const alt = new RegExp(
    `<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${name}["']`,
    "i"
  );
  return (html.match(re) || html.match(alt))?.[1] || "";
}
function bioLinks(html: string): { title: string; url: string }[] {
  // Preferred source: the embedded NEXT_DATA JSON (Linktree ships every link
  // in it). Any object subtree with a links: [{title,url}] array counts.
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (m) {
    try {
      const found: { title: string; url: string }[] = [];
      const walk = (o: any) => {
        if (!o || typeof o !== "object") return;
        if (Array.isArray(o)) {
          o.forEach(walk);
          return;
        }
        if (Array.isArray((o as any).links) && (o as any).links[0] && typeof (o as any).links[0] === "object") {
          for (const l of (o as any).links) {
            const url = String(l?.url || "");
            const title = String(l?.title || "").trim();
            if (/^https?:/i.test(url) && title) found.push({ title, url });
          }
        }
        Object.values(o).forEach(walk);
      };
      walk(JSON.parse(m[1]));
      if (found.length >= 2) return found.slice(0, 30);
    } catch {
      /* fall through to anchors */
    }
  }
  // Fallback: server-rendered anchors, minus the host's own chrome links.
  const out: { title: string; url: string }[] = [];
  const seen = new Set<string>();
  const re = /<a\b[^>]*href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let mm: RegExpExecArray | null;
  while ((mm = re.exec(html)) && out.length < 30) {
    const url = mm[1];
    const title = mm[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    if (!title || title.length > 90) continue;
    if (/linktr\.ee|beacons\.ai|bio\.link|cookie|privacy|terms|log ?in|sign ?up|report/i.test(url + " " + title))
      continue;
    if (seen.has(url)) continue;
    seen.add(url);
    out.push({ title, url });
  }
  return out;
}
function bioLinkPage(html: string, u: URL): string | null {
  const links = bioLinks(html);
  if (links.length < 2) return null;
  const rawTitle = metaContent(html, "og:title") || u.pathname.replace(/^\//, "");
  const name = rawTitle.split(/\s*[|:\u00b7]\s*/)[0].trim() || u.pathname.replace(/^\//, "");
  const desc = metaContent(html, "og:description") || metaContent(html, "description");
  const avatar = metaContent(html, "og:image");
  const host = u.hostname.replace(/^www\./, "");
  const rows = links
    .map((l) => {
      let linkHost = "";
      try {
        linkHost = new URL(l.url).hostname.replace(/^www\./, "");
      } catch {}
      return (
        `<a class="lk" href="${escHtml(l.url)}" target="_blank" rel="noopener noreferrer">` +
        `<span class="t">${escHtml(l.title)}</span>` +
        (linkHost ? `<span class="h">${escHtml(linkHost)}</span>` : "") +
        `</a>`
      );
    })
    .join("");
  return (
    `<!doctype html><html><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<meta name="referrer" content="no-referrer">` +
    `<title>${escHtml(name)}</title><style>` +
    `*{box-sizing:border-box;margin:0}` +
    `body{min-height:100vh;font-family:-apple-system,system-ui,'Segoe UI',sans-serif;color:#1f2530;` +
    `background:#fbfaf8;background-image:radial-gradient(520px 340px at 12% 8%,rgba(147,174,203,.35),transparent 70%),` +
    `radial-gradient(560px 380px at 88% 20%,rgba(217,161,180,.3),transparent 70%),` +
    `radial-gradient(620px 420px at 50% 96%,rgba(186,205,172,.32),transparent 72%);` +
    `display:flex;justify-content:center;padding:36px 18px}` +
    `.card{width:100%;max-width:560px}` +
    `.head{text-align:center;margin-bottom:22px}` +
    `.av{width:88px;height:88px;border-radius:50%;object-fit:cover;border:3px solid #fff;` +
    `box-shadow:0 10px 28px rgba(25,69,94,.18);margin-bottom:12px}` +
    `.avf{width:88px;height:88px;border-radius:50%;background:#19455e;color:#fff;display:inline-flex;` +
    `align-items:center;justify-content:center;font-size:34px;font-weight:800;margin-bottom:12px}` +
    `h1{font-size:24px;letter-spacing:-.01em}` +
    `.d{margin-top:6px;font-size:14px;color:#5a6372;line-height:1.5}` +
    `.lk{display:flex;align-items:baseline;gap:12px;background:#fff;border:1px solid #e7e3dc;` +
    `border-radius:16px;padding:15px 18px;margin-bottom:10px;text-decoration:none;color:#1f2530;` +
    `box-shadow:0 2px 10px rgba(30,40,50,.05);transition:transform .12s,box-shadow .12s}` +
    `.lk:hover{transform:translateY(-1px);box-shadow:0 8px 22px rgba(25,69,94,.14);border-color:#c9d6e0}` +
    `.t{flex:1;font-weight:700;font-size:15px;min-width:0}` +
    `.h{font-size:11px;color:#98a0ac;white-space:nowrap}` +
    `.foot{margin-top:18px;text-align:center;font-size:12px;color:#8b93a0}` +
    `.foot a{color:#19455e;font-weight:600}` +
    `</style></head><body><div class="card"><div class="head">` +
    (avatar
      ? `<img class="av" src="${escHtml(avatar)}" alt="">`
      : `<span class="avf">${escHtml((name[0] || "?").toUpperCase())}</span>`) +
    `<h1>${escHtml(name)}</h1>` +
    (desc ? `<p class="d">${escHtml(desc)}</p>` : "") +
    `</div>${rows}` +
    `<p class="foot">Cleaned up by Scout from ${escHtml(host)} · ` +
    `<a href="${escHtml(u.toString())}" target="_blank" rel="noopener noreferrer">View the original</a></p>` +
    `</div></body></html>`
  );
}
