import { NextRequest, NextResponse } from "next/server";
import { safeUrl } from "@/lib/pageText";

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
  const raw = req.nextUrl.searchParams.get("url") || "";
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
  const base = `<base href="${u.origin}${u.pathname.replace(/[^/]*$/, "")}">`;
  html = /<head[^>]*>/i.test(html)
    ? html.replace(/<head[^>]*>/i, (m) => `${m}${base}`)
    : `${base}${html}`;

  // Inject the autofill bridge (see AUTOFILL_SCRIPT). It lets the Scout panel
  // pre-fill a contact form the user is looking at, it never submits.
  html = /<\/body>/i.test(html)
    ? html.replace(/<\/body>/i, `${AUTOFILL_SCRIPT}</body>`)
    : `${html}${AUTOFILL_SCRIPT}`;

  return htmlResponse(html);
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
  function announce(){try{parent.postMessage({type:'scout-form-detected',hasForm:hasForm(),questions:questions()},'*');}catch(e){}}
  if(document.readyState==='loading'){document.addEventListener('DOMContentLoaded',announce);}else{setTimeout(announce,300);}
})();</script>`;

function htmlResponse(html: string): NextResponse {
  return new NextResponse(html, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
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
