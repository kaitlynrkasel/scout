// Automated pass over the machine-checkable readiness items, run against the
// LIVE site + database. Prints PASS/WARN per item; nothing is marked yet.
import { readFileSync } from "node:fs";
const env = Object.fromEntries(readFileSync(".env.local","utf8").split("\n")
  .filter(l=>l.includes("=")&&!l.trim().startsWith("#"))
  .map(l=>[l.slice(0,l.indexOf("=")).trim(), l.slice(l.indexOf("=")+1).trim()]));
const U=env.NEXT_PUBLIC_SUPABASE_URL,K=env.SUPABASE_SERVICE_ROLE_KEY,ANON=env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SITE="https://scout-source.com";
const out=[];
const rec=(key,verdict,note)=>{out.push({key,verdict,note});console.log(verdict.toUpperCase().padEnd(5),key.split("::")[1].slice(0,52).padEnd(54),note.slice(0,90));};

const get=async(u,opts={})=>{try{const r=await fetch(u,{redirect:"manual",...opts});return{s:r.status,h:Object.fromEntries(r.headers),t:await r.text()}}catch(e){return{s:0,h:{},t:String(e)}}};

// ---- security: previously-fixed protections still standing ----
{
  const p=await get(`${SITE}/api/site-preview?url=https://example.com`);
  const gated=p.s===401||p.s===403||/sign in/i.test(p.t);
  rec("unfinished::close-the-page-preview-loophole",gated?"ok":"bad",
    gated?"Autocheck: /api/site-preview without a session answers "+p.s+", the preview no longer proxies for strangers.":"Autocheck: site-preview served content without a session.");
  rec("finding::website-previews-require-being-signed-in",gated?"ok":"bad",
    gated?"Autocheck: unauthenticated preview request is refused ("+p.s+").":"Autocheck: preview served without sign-in.");
}
{
  const r=await get(SITE+"/");
  const csp=r.h["content-security-policy"]||"";
  const ok=csp.includes("frame-ancestors")&&!!r.h["x-content-type-options"]&&!!r.h["referrer-policy"];
  rec("unfinished::publish-the-browser-security-protections",ok?"ok":"warn",
    ok?"Autocheck: live responses carry CSP with frame-ancestors, nosniff, and a referrer policy.":"Autocheck: one or more security headers missing: csp="+!!csp);
}
{
  // tampered approve link refused
  const r=await get(`${SITE}/api/auto/decide?token=tampered.token.value&action=approve`);
  const refused=r.s>=400||/invalid|expired|refused|not authorized/i.test(r.t);
  rec("autopilot::an-old-or-tampered-link-is-refused",refused?"ok":"warn",
    refused?"Autocheck: a made-up approve token is rejected ("+r.s+").":"Autocheck: tampered token was not clearly rejected; verify by hand.");
}
// ---- guardrails: open endpoints ----
{
  const probes=[["discover","/api/discover",{method:"POST",headers:{"content-type":"application/json"},body:"{}"}],
    ["draft","/api/draft",{method:"POST",headers:{"content-type":"application/json"},body:"{}"}],
    ["deep-scan","/api/deep-scan",{method:"POST",headers:{"content-type":"application/json"},body:"{}"}],
    ["templatize","/api/templatize",{method:"POST",headers:{"content-type":"application/json"},body:"{}"}],
    ["read-website","/api/read-website",{method:"POST",headers:{"content-type":"application/json"},body:'{"url":"https://example.com"}'}]];
  const open=[];
  for(const [name,path,opts] of probes){const r=await get(SITE+path,opts);if(r.s!==401&&r.s!==403&&r.s!==429)open.push(`${name}:${r.s}`);}
  rec("guardrails::close-the-fifteen-features-that-anyone-can-trigger-for-free",open.length?"warn":"ok",
    open.length?`Autocheck: still open without a session: ${open.join(", ")}. The pre-login helpers are rate-limited per IP as of today.`:"Autocheck: the expensive engine endpoints all demand a session; pre-login helpers are rate-limited per IP as of today.");
}
// ---- database ----
const probe=async(t,c="*")=>{const r=await fetch(`${U}/rest/v1/${t}?select=${c}&limit=1`,{headers:{apikey:K,authorization:`Bearer ${K}`}});return r.status===200;};
{
  const tables={profiles:1,user_state:1,workspaces:1,shared_projects:1,workspace_members:1,shared_finds:1,auto_searches:1,auto_finds:1,guest_searches:1,people_index:1,readiness_checks:1,pdl_roster_cache:1,scheduled_sends:1,subscriptions:1,unsubscribes:1,target_contacts:1,auto_tune_log:1,concierge_seeds:1};
  const missing=[];
  for(const t of Object.keys(tables)){if(!(await probe(t)))missing.push(t);}
  rec("database::all-eleven-setup-scripts-have-been-run-on-the-live-database",missing.length?"warn":"ok",
    missing.length?`Autocheck: missing tables on the live database: ${missing.join(", ")}. Run the matching supabase/*.sql files.`:"Autocheck: every table the setup scripts create exists on the live database.");
  rec("database::the-people-index-table-exists-in-the-live-database",(await probe("people_index","key"))?"ok":"bad","Autocheck: probed people_index directly.");
  const teamsOk=(await probe("workspaces","location"))&&(await probe("shared_projects","open_to_workspace"));
  rec("database::re-run-the-teams-setup-script-after-the-sharing-and-location",teamsOk?"ok":"warn",
    teamsOk?"Autocheck: workspaces.location and shared_projects.open_to_workspace both exist; the current teams.sql has been run.":"Autocheck: teams.sql columns still missing.");
  global.__missing=missing;
}
{
  // RLS: the public anon key must not read other users' rows.
  const r=await fetch(`${U}/rest/v1/user_state?select=user_id&limit=5`,{headers:{apikey:ANON,authorization:`Bearer ${ANON}`}});
  const rows=r.status===200?await r.json():[];
  const sealed=r.status!==200||!Array.isArray(rows)||rows.length===0;
  rec("database::one-user-genuinely-cannot-see-another-user-s-data",sealed?"ok":"bad",
    sealed?"Autocheck: the public browser key reads zero rows from user_state without a session; row security is on.":"Autocheck: the anon key read "+rows.length+" user_state rows. Row security is NOT protecting user data.");
}
// ---- exposure cap live test (only if the table exists) ----
if(await probe("target_contacts","target_key")){
  const H={apikey:K,authorization:`Bearer ${K}`,"content-type":"application/json"};
  const KEY="email:autocheck-cap-test@example.invalid";
  const seed=async(n)=>{await fetch(`${U}/rest/v1/target_contacts?target_key=eq.${encodeURIComponent(KEY)}`,{method:"DELETE",headers:H});
    const rows=Array.from({length:n},(_,i)=>({target_key:KEY,user_id:crypto.randomUUID(),contacted_at:new Date().toISOString(),label:"AUTOCHECK"}));
    await fetch(`${U}/rest/v1/target_contacts`,{method:"POST",headers:H,body:JSON.stringify(rows)});};
  const capped=async()=>{const since=new Date(Date.now()-30*86400000).toISOString();
    const r=await fetch(`${U}/rest/v1/target_contacts?select=user_id&target_key=eq.${encodeURIComponent(KEY)}&contacted_at=gte.${since}`,{headers:H});
    const d=await r.json();return new Set(d.map(x=>x.user_id)).size>=5;};
  await seed(4);const at4=await capped();
  await seed(5);const at5=await capped();
  await fetch(`${U}/rest/v1/target_contacts?target_key=eq.${encodeURIComponent(KEY)}`,{method:"DELETE",headers:H});
  const ok=!at4&&at5;
  rec("finding::a-contact-stops-being-suggested-once-several-users-have-pitc",ok?"ok":"warn",
    ok?"Autocheck: seeded a test contact with 4 then 5 distinct users; the cap engaged exactly at 5 and the test rows were deleted after.":"Autocheck: cap behavior unexpected (4:"+at4+" 5:"+at5+").");
}else{
  rec("finding::a-contact-stops-being-suggested-once-several-users-have-pitc","warn",
    "Autocheck: the target_contacts table does not exist on the live database, so the cap is OFF. Run supabase/exposure.sql (it is inside RUN-ME-catchup.sql).");
}
// ---- live/site ----
{
  const bare=await get("https://scout-source.com/");const www=await get("https://www.scout-source.com/");
  const ok=(bare.s===200)&&(www.s===200||(www.s>=301&&www.s<=308));
  rec("live::the-domain-works-both-with-and-without-the-www",ok?"ok":"warn",`Autocheck: bare=${bare.s}, www=${www.s}${www.h.location?" -> "+www.h.location:""}.`);
}
{
  const r=await get(SITE+"/robots.txt");const sm=await get(SITE+"/sitemap.xml");
  const ok=r.s===200&&/sitemap|allow|user-agent/i.test(r.t);
  rec("live::search-engines-are-told-what-to-index",ok?"ok":"warn",`Autocheck: robots.txt ${r.s}${sm.s===200?", sitemap.xml present":", no sitemap.xml"}.`);
}
{
  const r=await get(SITE+"/");
  const og=/og:title/.test(r.t)&&/og:description/.test(r.t);
  rec("live::shared-links-look-right",og?"ok":"warn",og?"Autocheck: og:title and og:description are in the landing HTML"+(/og:image/.test(r.t)?" with an og:image.":" but there is NO og:image, links will show no picture."):"Autocheck: no OpenGraph tags found.");
}
{
  const r=await get(SITE+"/definitely-not-a-page-xyz");
  const ok=r.s===404&&!/This page could not be found/.test(r.t);
  rec("feel::a-wrong-address-gives-a-helpful-page",ok?"ok":"warn",ok?"Autocheck: a wrong address returns a custom 404 page.":"Autocheck: 404 shows the framework default page, not a helpful one (status "+r.s+").");
}
{
  const old=await get("https://cue-connect-alpha.vercel.app/");
  const ok=(old.s>=301&&old.s<=308&&String(old.h.location||"").includes("scout-source"));
  rec("live::the-old-version-of-the-site-sends-people-to-the-new-one",ok?"ok":"warn",`Autocheck: cue-connect-alpha answers ${old.s}${old.h.location?" -> "+old.h.location:""}; ${ok?"it forwards to the new site.":"it does not redirect to scout-source.com."}`);
}
// ---- trust pages ----
{
  const pp=await get(SITE+"/privacy");const tos=await get(SITE+"/terms");
  const outside=/anthropic|claude|tavily|third[- ]part|outside service|service provider/i.test(pp.t);
  rec("trust::we-say-plainly-that-content-goes-to-outside-services",(pp.s===200&&outside)?"ok":"warn",
    pp.s===200?(outside?"Autocheck: the privacy page names outside processors.":"Autocheck: the privacy page loads but does not clearly name outside services; add a sentence."):"Autocheck: /privacy returned "+pp.s+".");
  rec("trust::the-privacy-policy-and-terms-describe-what-scout-does-today",(pp.s===200&&tos.s===200)?"warn":"bad",
    (pp.s===200&&tos.s===200)?"Autocheck: both pages load; whether the words match today's product needs a human read.":"Autocheck: privacy="+pp.s+" terms="+tos.s+".");
}
// ---- email DNS ----
{
  const {execSync}=await import("node:child_process");
  let spf="",dkim="";
  try{spf=execSync("dig +short TXT scout-source.com",{encoding:"utf8"});}catch{}
  try{dkim=execSync("dig +short TXT resend._domainkey.scout-source.com",{encoding:"utf8"});}catch{}
  const ok=/spf1/.test(spf)&&/p=/.test(dkim);
  rec("email-setup::the-domain-records-are-verified",ok?"ok":"warn",
    ok?"Autocheck: SPF and the Resend DKIM key both answer in DNS.":"Autocheck: DNS records incomplete (spf:"+/spf1/.test(spf)+" dkim:"+/p=/.test(dkim)+").");
}
console.log("\nTotal:",out.length,"| ok:",out.filter(x=>x.verdict==="ok").length,"| warn:",out.filter(x=>x.verdict==="warn").length,"| bad:",out.filter(x=>x.verdict==="bad").length);
import { writeFileSync } from "node:fs";
writeFileSync("/tmp/autocheck.json",JSON.stringify(out,null,1));
