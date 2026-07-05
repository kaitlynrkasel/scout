import { NextRequest, NextResponse } from "next/server";
import { safeUrl } from "@/lib/pageText";

export const runtime = "nodejs";
export const maxDuration = 20;

// Serves a site's HTML back through OUR origin so the find-detail preview
// iframe can embed it. Embedding the target URL directly gets blocked by
// X-Frame-Options / CSP frame-ancestors on most real sites ("refused to
// connect") — that's the browser enforcing headers on the direct cross-origin
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
    const r = await fetch(u.toString(), {
      headers: {
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        accept: "text/html,application/xhtml+xml",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) {
      return htmlResponse(
        errorPage(`This site returned an error (${r.status}) when Scout tried to preview it.`, u.toString())
      );
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

  // Cap payload size — this is a visual preview, not a full mirror.
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
  // pre-fill a contact form the user is looking at — it never submits.
  html = /<\/body>/i.test(html)
    ? html.replace(/<\/body>/i, `${AUTOFILL_SCRIPT}</body>`)
    : `${html}${AUTOFILL_SCRIPT}`;

  return htmlResponse(html);
}

// Runs inside the proxied page (same origin as the app, so postMessage is
// trusted). Two jobs:
//   1. On load, report whether the page has a fillable contact form, so the
//      panel only offers "Fill this form" when there's something to fill.
//   2. On a 'scout-autofill' message, heuristically map the sender's details +
//      drafted message onto the form's fields and highlight them. It stops
//      short of submitting — the user reviews and sends themselves.
const AUTOFILL_SCRIPT = `<script>(function(){
  function sig(el){
    var bits=[el.name,el.id,el.placeholder,el.getAttribute('aria-label'),el.type];
    try{
      var lbl=el.labels&&el.labels[0]?el.labels[0].textContent:'';
      if(!lbl&&el.id){var l=document.querySelector('label[for="'+el.id+'"]');lbl=l?l.textContent:'';}
      if(!lbl){var p=el.closest('label');lbl=p?p.textContent:'';}
      bits.push(lbl);
    }catch(e){}
    return bits.join(' ').toLowerCase();
  }
  function fields(){
    var out=[];
    var els=document.querySelectorAll('input,textarea');
    for(var i=0;i<els.length;i++){
      var el=els[i];
      if(el.type==='hidden'||el.type==='submit'||el.type==='button'||el.type==='checkbox'||el.type==='radio'||el.type==='file'||el.disabled||el.readOnly)continue;
      if(el.offsetParent===null&&el.type!=='hidden')continue;
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
      el.style.outline='2px solid #7c5837';
      el.style.outlineOffset='1px';
    }catch(e){el.value=val;}
  }
  function hasForm(){
    var f=fields();
    for(var i=0;i<f.length;i++){
      var s=sig(f[i]);
      if(f[i].tagName==='TEXTAREA'||f[i].type==='email'||/email|message|name|comment|inquir/.test(s))return true;
    }
    return false;
  }
  function fill(d){
    var f=fields(),firstDone=false,lastDone=false,nameDone=false,emailDone=false,msgDone=false,firstEl=null;
    for(var i=0;i<f.length;i++){
      var el=f[i],s=sig(el);
      if(/compan|organi|business/.test(s))continue;
      if(!emailDone&&(el.type==='email'||/e-?mail/.test(s))){if(d.email){setVal(el,d.email);emailDone=true;firstEl=firstEl||el;}continue;}
      if(!firstDone&&/first|given/.test(s)&&/name/.test(s)){if(d.first){setVal(el,d.first);firstDone=true;firstEl=firstEl||el;}continue;}
      if(!lastDone&&/last|surname|family/.test(s)&&/name|surname|family/.test(s)){if(d.last){setVal(el,d.last);lastDone=true;firstEl=firstEl||el;}continue;}
      if(!msgDone&&(el.tagName==='TEXTAREA'||/message|comment|project|tell us|inquir|note|detail|help/.test(s))){if(d.message){setVal(el,d.message);msgDone=true;firstEl=firstEl||el;}continue;}
      if(!nameDone&&!firstDone&&/name/.test(s)){if(d.name){setVal(el,d.name);nameDone=true;firstEl=firstEl||el;}continue;}
    }
    if(firstEl){try{firstEl.scrollIntoView({behavior:'smooth',block:'center'});}catch(e){}}
    return emailDone||firstDone||nameDone||msgDone;
  }
  window.addEventListener('message',function(ev){
    var d=ev&&ev.data;if(!d||d.type!=='scout-autofill')return;
    var ok=fill(d.payload||{});
    try{parent.postMessage({type:'scout-autofill-done',filled:ok},'*');}catch(e){}
  });
  function announce(){try{parent.postMessage({type:'scout-form-detected',hasForm:hasForm()},'*');}catch(e){}}
  if(document.readyState==='loading'){document.addEventListener('DOMContentLoaded',announce);}else{announce();}
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
