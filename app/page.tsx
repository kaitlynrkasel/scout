import localFont from "next/font/local";
import LandingMotion from "./LandingMotion";

const anton = localFont({
  variable: "--font-anton", display: "swap",
  src: [{ path: "./fonts/anton.woff2", weight: "400", style: "normal" }],
});
const bric = localFont({
  variable: "--font-bric", display: "swap",
  src: [
    { path: "./fonts/bricolage-500.woff2", weight: "500", style: "normal" },
    { path: "./fonts/bricolage-700.woff2", weight: "700", style: "normal" },
  ],
});
const inter = localFont({
  variable: "--font-inter", display: "swap",
  src: [
    { path: "./fonts/inter-400.woff2", weight: "400", style: "normal" },
    { path: "./fonts/inter-600.woff2", weight: "600", style: "normal" },
    { path: "./fonts/inter-800.woff2", weight: "800", style: "normal" },
  ],
});

const LANDING_DESCRIPTION =
  "Scout finds the people and opportunities that fit your goal, pulls their contact info, and drafts personalized outreach that sounds like you.";

export const metadata = {
  title: "Scout | Find Your People",
  description: LANDING_DESCRIPTION,
  openGraph: {
    title: "Scout | Find Your People",
    description: LANDING_DESCRIPTION,
    url: "https://scout-source.com",
    siteName: "Scout",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Scout | Find Your People",
    description: LANDING_DESCRIPTION,
  },
};

// Landing page. Warm "collision" design system; the display face (Anton) is used
// ONLY on the hero "Find Your People" wordmark. Beige dashed blocks are photo
// slots to be replaced with real dog imagery. The full-width dark band (#dog-runner)
// is the mount point for the running-dog intro animation.
const CSS = `
  :root{
    --paper:#F5F2EB; --paper2:#E9D4C3; --ink:#3A2A1B; --cream:#F9F5EE;
    /* Pantone board — Mystic Navy (#13273F) is the deep anchor: CTAs + the dark
       band. Dusty blue (#8496B4) is the light accent (stickers). Chocolate
       Cremoso browns + Mother of Pearl tan (paper2) are the warm identity.
       --blue = navy fills, --blue-ink = navy labels, --blue-mid = dusty blue. */
    --blue:#13273F; --blue-ink:#1E3A5C; --blue-mid:#8496B4;
    --terra:#5A4331; --terra-deep:#42301F; --olive:#536872;
    --muted:#8B8271; --line:#DED6C7; --border:#D2C9B8; --dark:#2A2017;
    --r:12px; --rs:9px;
  }
  .scoutland *{box-sizing:border-box;margin:0;padding:0}
  .scoutland{min-height:100vh;background:var(--paper);color:#4a4336;font-family:var(--font-inter),system-ui,sans-serif;-webkit-font-smoothing:antialiased;overflow-x:hidden}
  .anton{font-family:var(--font-anton),Impact,sans-serif;font-weight:400;text-transform:uppercase}
  .disp{font-family:var(--font-bric),system-ui,sans-serif;font-weight:700;color:var(--ink);letter-spacing:-.02em;line-height:1.04}
  .wrap{max-width:1180px;margin:0 auto;padding:0 40px;position:relative}
  .scoutland a{color:inherit;text-decoration:none}
  .kicker{font-size:12px;font-weight:700;letter-spacing:.16em;text-transform:uppercase;color:var(--blue-ink)}
  .h2{font-family:var(--font-bric),system-ui,sans-serif;font-weight:700;font-size:46px;line-height:1.04;letter-spacing:-.015em;color:var(--ink);margin-top:14px}
  .h2 em{font-style:normal;color:var(--terra)}
  .lead{font-size:16.5px;line-height:1.6;color:#57503f;max-width:54ch;margin-top:14px}
  .btn{display:inline-flex;align-items:center;gap:8px;font-size:14px;font-weight:600;padding:13px 22px;cursor:pointer;border:0;border-radius:var(--rs)}
  /* Higher specificity than the .scoutland a color:inherit rule so the label
     stays white on the blue fill (a plain .btn-t rule loses to the anchor). */
  .scoutland a.btn-t,.scoutland .btn-t{background:var(--blue);color:#fff}
  .btn-o{background:transparent;color:var(--ink);border:1px solid #cfc5b2;padding:12px 21px;transition:background .15s ease,color .15s ease,border-color .15s ease}
  .btn-o:hover{background:var(--blue);color:#fff;border-color:var(--blue)}
  .slot{position:relative;background:var(--paper2);border-radius:var(--r);overflow:hidden}
  .slot::after{content:"";position:absolute;inset:12px;border:1px dashed #C7BBA6;border-radius:6px}
  .slot .t{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;color:var(--muted);font-size:11px;font-weight:600;letter-spacing:.06em}

  /* nav */
  .scoutland nav{position:relative;z-index:40;display:flex;align-items:center;height:76px;border-bottom:1px solid var(--border)}
  .scoutland nav .brand{display:flex;align-items:center;gap:9px;font-weight:700;font-size:19px;letter-spacing:-.01em;color:var(--ink)}
  .scoutland nav .brand img{width:26px;height:26px}
  .scoutland nav .nl{margin-left:46px;display:flex;gap:26px;font-size:14px;font-weight:500;color:#5b5344}
  .scoutland nav .cta{margin-left:auto;background:var(--blue);color:#fff;font-size:13.5px;font-weight:600;padding:11px 18px;border-radius:var(--rs)}

  /* HERO — the one loud moment */
  .hero{position:relative;height:748px;overflow:hidden}
  .herwrap{position:relative;max-width:1180px;height:100%;margin:0 auto}
  .eyebrow{position:absolute;top:30px;left:40px;z-index:20;font-size:11px;font-weight:600;letter-spacing:.2em;text-transform:uppercase;color:var(--blue-ink)}
  .eyebrow2{position:absolute;top:30px;right:40px;z-index:20;font-size:11px;font-weight:600;letter-spacing:.2em;text-transform:uppercase;color:var(--muted)}
  .backword{position:absolute;left:-24px;top:232px;z-index:1;font-family:var(--font-bric),system-ui,sans-serif;font-weight:700;font-size:340px;line-height:.8;color:transparent;-webkit-text-stroke:1.5px rgba(36,28,19,.09);white-space:nowrap}
  .headline{position:absolute;left:52px;top:104px;z-index:3}
  .headline .l{display:block;font-size:158px;line-height:.80;letter-spacing:.5px;color:var(--ink)}
  .dog{position:absolute;right:26px;top:104px;z-index:4;width:470px;height:540px;border-radius:var(--r);background:var(--paper2);box-shadow:0 34px 70px -34px rgba(36,28,19,.38)}
  .dog::after{content:"";position:absolute;inset:14px;border:1px dashed #C7BBA6;border-radius:6px}
  .dog .lab{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;color:var(--muted);text-align:center}
  .dog .lab .t{font-size:11px;font-weight:600;letter-spacing:.08em;margin-top:10px}
  .dog .lab .s{font-size:12px;margin-top:5px;color:#A99E88}
  .sticker{position:absolute;right:44px;top:78px;z-index:8;background:var(--blue-mid);color:#13273F;font-size:11px;font-weight:700;letter-spacing:.06em;padding:9px 14px;border-radius:var(--rs)}
  .sticker2{position:absolute;left:548px;top:196px;z-index:8;background:var(--olive);color:#F5F2EB;font-size:11px;font-weight:600;letter-spacing:.04em;padding:8px 13px;border-radius:var(--rs)}
  .ledechip{position:absolute;left:56px;top:506px;z-index:7;width:404px;background:var(--cream);border:1px solid var(--border);border-radius:var(--r);padding:22px;box-shadow:0 20px 44px -30px rgba(36,28,19,.26)}
  .ledechip p{font-size:15.5px;line-height:1.55;color:#4a4336}
  .ledechip .row{margin-top:18px;display:flex;gap:12px;align-items:center}

  /* run band — quieter */
  .run{position:relative;height:210px;background:var(--dark);overflow:hidden;display:flex;align-items:center}
  .run .big{position:absolute;left:0;white-space:nowrap;font-family:var(--font-bric),system-ui,sans-serif;font-weight:700;font-size:104px;line-height:1;color:transparent;-webkit-text-stroke:1px rgba(245,242,235,.14);top:34px}
  .run .ground{position:absolute;left:0;right:0;bottom:44px;height:1px;background:rgba(245,242,235,.22)}
  .run .cap{position:relative;z-index:2;width:100%;text-align:center;color:#BCB09A}
  .run .cap .t{font-size:11px;font-weight:600;letter-spacing:.16em;text-transform:uppercase}
  .run .cap .s{font-size:12.5px;margin-top:7px}
  .run .runner{position:absolute;bottom:44px;left:9%;z-index:3;width:120px;height:120px;background:rgba(245,242,235,.05);border:1px dashed rgba(245,242,235,.34);border-radius:var(--r)}
  .run .dogrun{position:absolute;left:0;bottom:44px;height:152px;width:auto;z-index:3;pointer-events:none;will-change:transform}

  .sec{padding:64px 0}

  /* HOW IT WORKS — asymmetric: heading left, numbered list right */
  .how{display:grid;grid-template-columns:0.9fr 1.1fr;gap:48px;align-items:center}
  .howlist{margin-top:8px}
  .howrow{display:grid;grid-template-columns:auto 1fr;gap:22px;padding:26px 0;border-bottom:1px solid var(--line)}
  .howrow:first-child{border-top:1px solid var(--line)}
  .howrow .rn{font-family:var(--font-bric),system-ui,sans-serif;font-weight:700;font-size:40px;color:var(--terra);line-height:1}
  .howrow h3{font-size:19px;font-weight:600;color:var(--ink)}
  .howrow p{font-size:15px;line-height:1.6;color:#57503f;margin-top:7px;max-width:46ch}

  /* USES — overlapping cards (the collision) + example list */
  .stack{position:relative;margin-top:36px;height:492px}
  .card{position:absolute;width:340px;background:var(--cream);border:1px solid var(--border);border-radius:var(--r);overflow:hidden}
  .card .ph{height:196px;background:var(--paper2);position:relative}
  .card .ph::after{content:"";position:absolute;inset:12px;border:1px dashed #C7BBA6;border-radius:6px}
  .card .ph .t{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:600;color:var(--muted)}
  .card .bd{padding:18px}
  .card .who{font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--terra-deep)}
  .card h3{font-family:var(--font-bric),system-ui,sans-serif;font-weight:700;font-size:27px;margin-top:6px;color:var(--ink)}
  .card p{font-size:14px;line-height:1.5;color:#57503f;margin-top:8px}
  .c1{left:0;top:0;z-index:3}
  .c2{left:300px;top:150px;z-index:4;box-shadow:0 34px 66px -36px rgba(36,28,19,.36)}
  .c3{left:640px;top:44px;z-index:2}
  .exlist{margin-top:28px;border-top:1px solid var(--border)}
  .exrow{display:flex;align-items:center;gap:16px;padding:13px 4px;border-bottom:1px solid var(--line)}
  .exrow svg{color:var(--terra);flex:0 0 auto}
  .exrow .who{font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);width:140px;flex:0 0 auto}
  .exrow .q{font-family:var(--font-bric),system-ui,sans-serif;font-size:18px;color:var(--ink)}

  /* 3 STEPS */
  .steps{display:grid;grid-template-columns:repeat(3,1fr);gap:34px;margin-top:36px}
  .step{border-top:1px solid var(--ink);padding-top:20px}
  .step .n{font-family:var(--font-bric),system-ui,sans-serif;font-weight:700;font-size:52px;line-height:.9;color:var(--ink)}
  .step h3{font-size:16px;font-weight:600;color:var(--ink);margin-top:12px}
  .step p{font-size:14.5px;line-height:1.55;color:#57503f;margin-top:9px;max-width:30ch}

  /* VOICE */
  .voicegrid{display:grid;grid-template-columns:1fr 1fr;gap:52px;align-items:center;margin-top:32px}
  .vbul{margin-top:24px;display:flex;flex-direction:column;gap:18px}
  .vbul .b{display:flex;gap:15px}
  .vbul .num{font-family:var(--font-bric),system-ui,sans-serif;font-size:22px;color:var(--terra);line-height:1.1;flex:0 0 auto}
  .vbul .bt{font-size:15.5px;line-height:1.55;color:#57503f}
  .vbul .bt b{color:var(--ink);font-weight:600}
  .msg{background:var(--cream);border:1px solid var(--border);border-radius:var(--r);padding:16px 18px}
  .msg + .msg{margin-top:-16px;margin-left:44px;box-shadow:0 26px 54px -34px rgba(36,28,19,.34)}
  .msg .lbl{font-size:10.5px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;margin-bottom:8px}
  .msg.gen{opacity:.7} .msg.gen .lbl{color:var(--muted)} .msg.gen p{color:#7a7264;text-decoration:line-through;text-decoration-color:#cfc3af}
  .msg.you{border-left:3px solid var(--olive)} .msg.you .lbl{color:#536872}
  .msg p{font-size:14.5px;line-height:1.55;color:#463f33}

  /* TEAM */
  .teamgrid{display:grid;grid-template-columns:repeat(3,1fr);gap:26px;margin-top:32px}
  .member .ph{height:260px}
  .member .nm{font-family:var(--font-bric),system-ui,sans-serif;font-weight:700;font-size:24px;margin-top:16px;color:var(--ink)}
  .member .rl{font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--terra-deep);margin-top:4px}
  .pack{margin-top:46px}
  .packrow{display:flex;gap:18px;margin-top:16px}
  .packrow .p{flex:1;height:132px}

  /* HELPS — stat strip (distinct from steps) */
  .statstrip{display:grid;grid-template-columns:repeat(3,1fr);margin-top:32px;border-top:1px solid var(--border)}
  .st{padding:30px 34px 8px;border-left:1px solid var(--line)}
  .st:first-child{border-left:0;padding-left:0}
  .st .n{font-family:var(--font-bric),system-ui,sans-serif;font-weight:700;font-size:64px;line-height:.9;color:var(--ink)}
  .st h3{font-size:14px;font-weight:600;color:var(--ink);margin-top:12px}
  .st p{font-size:14px;line-height:1.55;color:#57503f;margin-top:7px;max-width:28ch}

  /* CONTACT */
  .contact{background:var(--dark);color:#EDE6D6}
  .contact .inner{display:grid;grid-template-columns:1fr 1fr;gap:64px;align-items:center;padding:100px 0}
  .contact h2{font-family:var(--font-bric),system-ui,sans-serif;font-weight:700;font-size:54px;line-height:1.02;letter-spacing:-.015em;color:#F7F3EB;margin-top:14px}
  .contact h2 em{font-style:normal;color:#B98A57}
  .contact .k{color:#B98A57}
  .contact p{font-size:16px;line-height:1.65;color:#C4B9A7;margin-top:18px;max-width:40ch}
  .form{display:flex;flex-direction:column;gap:14px}
  .form .two{display:grid;grid-template-columns:1fr 1fr;gap:14px}
  .inp{background:rgba(245,242,235,.05);border:1px solid rgba(245,242,235,.18);border-radius:var(--rs);padding:14px 15px;color:#F2ECDE;font-size:14.5px;font-family:inherit}
  .inp::placeholder{color:#9b9384}
  .form textarea{min-height:112px;resize:vertical}
  .form .send{align-self:flex-start}
  /* On the dark contact band the navy .btn-t would be muddy — give the send
     button the dusty-blue fill with navy text so it pops. */
  .scoutland .contact .btn-t{background:var(--blue-mid);color:#13273F}
  .contact .em{margin-top:16px;font-size:13.5px;color:#B7AB96}
  .contact .em b{color:#EDE6D6}

  .scoutland footer{padding:42px 0 54px}
  .foot{display:flex;align-items:center;gap:14px;font-size:13px;color:var(--muted);border-top:1px solid var(--border);padding-top:28px}
  .foot .brand{display:flex;align-items:center;gap:9px;font-weight:700;color:var(--ink)}
  .foot .brand img{width:20px;height:20px}
  .foot .links{margin-left:auto;display:flex;gap:22px;font-weight:500;color:#5b5344}

  /* responsive */
  @media (max-width: 980px){
    .scoutland .wrap{padding:0 22px}
    .scoutland nav .nl{display:none}
    .hero{height:auto;overflow:visible;padding-bottom:34px}
    .herwrap{height:auto}
    .hero .eyebrow{position:static;display:inline-block;margin:22px 0 0 22px}
    .hero .eyebrow2,.sticker,.backword{display:none}
    .headline{position:static;padding:0 22px;margin-top:14px}
    .headline .l{font-size:74px;line-height:.84}
    .dog{position:static;width:auto;height:300px;margin:22px 22px 0}
    .ledechip{position:static;width:auto;margin:20px 22px 0}
    .run .big{font-size:64px}
    .run .cap .s{padding:0 22px}
    .how{grid-template-columns:1fr;gap:26px}
    .stack{height:auto;display:flex;flex-direction:column;gap:16px;margin-top:24px}
    .card{position:static;width:auto}
    .steps{grid-template-columns:1fr;gap:0}
    .step{border-top:none;border-bottom:1px solid var(--line);padding:18px 0}
    .voicegrid{grid-template-columns:1fr;gap:26px}
    .msg + .msg{margin-left:0}
    .teamgrid{grid-template-columns:1fr}
    .member .ph{height:300px}
    .packrow{flex-wrap:wrap}
    .packrow .p{flex:1 1 40%;min-width:140px}
    .statstrip{grid-template-columns:1fr}
    .st{border-left:none;border-top:1px solid var(--line);padding:22px 0 8px}
    .st:first-child{border-top:none;padding-top:8px}
    .contact .inner{grid-template-columns:1fr;gap:26px;padding:64px 0}
    .form .two{grid-template-columns:1fr}
    .h2{font-size:34px}
    .contact h2{font-size:40px}
  }
  @media (prefers-reduced-motion: reduce){
    .scoutland *{animation:none !important;transition:none !important}
    .run .dogrun{display:none}
  }
`;
const BODY = `

<div class="wrap"><nav>
  <div class="brand"><img src="/scout-logo.png">Scout</div>
  <div class="nl"><a href="#how">How it works</a><a href="#uses">Uses</a><a href="#steps">Get started</a><a href="#team">Team</a><a href="#contact">Contact</a></div>
  <a class="cta" href="/app">Try Scout free</a>
</nav></div>

<!-- HERO -->
<section class="hero"><div class="herwrap">
  <div class="eyebrow">Professional networking, fetched</div>
  <div class="eyebrow2">Don&apos;t waste time.</div>
  <div class="backword">Scout</div>
  <div class="headline anton"><span class="l">Find</span><span class="l">Your</span><span class="l">People</span></div>
  <div class="dog"><div class="lab">
    <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3"><rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="12" cy="12" r="3.4"/><path d="M7 5l1.2-2h7.6L17 5"/></svg>
    <div class="t">Template photo</div><div class="s">dog leaps through the letters</div>
  </div></div>
  <div class="sticker">Fetch · Track · Find</div>
  <div class="ledechip">
    <p>Scout hunts down the mentors, recruiters, and alumni who fit your goal, then drafts a warm intro in your own voice.</p>
    <div class="row"><a class="btn btn-t" href="/app">Start scouting →</a><a class="btn btn-o" href="#how">How it works</a></div>
  </div>
</div></section>

<!-- RUN BAND -->
<section class="run">
  <div class="big">go fetch &nbsp;·&nbsp; go fetch &nbsp;·&nbsp; go fetch &nbsp;·&nbsp; go fetch &nbsp;·&nbsp; go fetch &nbsp;·&nbsp; go fetch &nbsp;·&nbsp; go fetch &nbsp;·&nbsp; go fetch &nbsp;·&nbsp; go fetch &nbsp;·&nbsp; go fetch &nbsp;·&nbsp; go fetch &nbsp;·&nbsp; go fetch &nbsp;·&nbsp; go fetch &nbsp;·&nbsp; go fetch &nbsp;·&nbsp; go fetch &nbsp;·&nbsp; go fetch &nbsp;·&nbsp; go fetch &nbsp;·&nbsp; go fetch &nbsp;·&nbsp; go fetch &nbsp;·&nbsp; go fetch &nbsp;·&nbsp; </div>
  <div class="ground"></div>
  <img class="dogrun" id="dog-runner" src="/dog-run.gif" alt="Scout the dog, running" onerror="this.style.display=&#39;none&#39;" />
</section>

<!-- HOW IT WORKS (asymmetric) -->
<section class="sec" id="how"><div class="wrap how">
  <div>
    <div class="kicker">How it works</div>
    <h2 class="h2">Scout does the <em style="color:#8A5A34">hunting</em>.</h2>
    <p class="lead">No database of stale leads. It reads the live public web the moment you ask, then hands you real people and a message worth sending.</p>
    <a class="btn btn-o" style="margin-top:22px" href="#steps">See how to start →</a>
  </div>
  <div class="howlist">
    <div class="howrow"><div class="rn">01</div><div><h3>Search the open web</h3><p>Describe who you want in plain language. Scout scours public pages, not a recycled list.</p></div></div>
    <div class="howrow"><div class="rn">02</div><div><h3>Pull real contacts</h3><p>It extracts real names, roles, and emails, and scores each match against your goal.</p></div></div>
    <div class="howrow"><div class="rn">03</div><div><h3>Draft in your voice</h3><p>Every message is written to sound like you, formatted for the right channel.</p></div></div>
  </div>
</div></section>

<!-- USES -->
<section class="sec" id="uses" style="background:#EFE7D6"><div class="wrap">
  <div style="max-width:640px"><div class="kicker">What you can use it for</div><h2 class="h2">Whatever you're hunting for.</h2></div>
  <div class="stack">
    <div class="card c1"><div class="ph"><div class="t">Template photo</div></div><div class="bd"><div class="who">For students</div><h3>Coffee chats &amp; alumni</h3><p>Alumni in your field, opened with a note that doesn't read like a cold email.</p></div></div>
    <div class="card c2"><div class="ph"><div class="t">Template photo</div></div><div class="bd"><div class="who">For job seekers</div><h3>Recruiters &amp; referrals</h3><p>The people hiring right now, with a warm intro ready to send.</p></div></div>
    <div class="card c3"><div class="ph"><div class="t">Template photo</div></div><div class="bd"><div class="who">For founders</div><h3>Partners &amp; press</h3><p>Point the whole team at one pipeline of real contacts.</p></div></div>
  </div>
  <div class="exlist">
    <div class="exrow"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg><span class="who">Job seeker</span><span class="q">Recruiters hiring remote UX designers</span></div>
    <div class="exrow"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg><span class="who">Founder</span><span class="q">Heads of growth at Series A SaaS companies</span></div>
    <div class="exrow"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg><span class="who">Musician</span><span class="q">Playlist curators for indie bedroom-pop</span></div>
    <div class="exrow"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg><span class="who">Nonprofit</span><span class="q">Local businesses to sponsor our charity 5K</span></div>
  </div>
</div></section>

<!-- 3 STEPS -->
<section class="sec" id="steps"><div class="wrap">
  <div style="max-width:640px"><div class="kicker">How to use it</div><h2 class="h2">Up and running in three steps.</h2></div>
  <div class="steps">
    <div class="step"><div class="n">01</div><h3>Tell Scout your goal</h3><p>Describe the people or opportunities you want, in your own words.</p></div>
    <div class="step"><div class="n">02</div><h3>Review your finds</h3><p>Real people, scored by fit, each with a draft already written.</p></div>
    <div class="step"><div class="n">03</div><h3>Send in your voice</h3><p>Tweak anything you like, then reach out on the right channel.</p></div>
  </div>
</div></section>

<!-- VOICE -->
<section class="sec" id="voice" style="background:#EFE7D6"><div class="wrap">
  <div style="max-width:640px"><div class="kicker">It sounds like you</div><h2 class="h2">Scout learns your <em>voice</em>.</h2></div>
  <div class="voicegrid">
    <div>
      <p class="lead" style="margin-top:0">The more you use it, the more it sounds like you, not a template. Feed it a little of your writing and it mirrors your tone from day one.</p>
      <div class="vbul">
        <div class="b"><span class="num">1</span><span class="bt"><b>Paste a few of your own messages.</b> Scout picks up your rhythm, warmth, and go-to phrasing.</span></div>
        <div class="b"><span class="num">2</span><span class="bt"><b>Edit any draft.</b> It remembers the change and applies it next time.</span></div>
        <div class="b"><span class="num">3</span><span class="bt"><b>Approve coaching tips.</b> Steer every future draft with a tap.</span></div>
      </div>
    </div>
    <div>
      <div class="msg gen"><div class="lbl">Generic</div><p>Hi, I came across your profile and wanted to connect regarding potential opportunities at your company.</p></div>
      <div class="msg you"><div class="lbl">In your voice</div><p>Hey Rina — saw Northwind hit #1 on Product Hunt. I'm deep in growth right now and would love 15 minutes on how you found your first 1k users.</p></div>
    </div>
  </div>
</div></section>

<!-- TEAM -->
<section class="sec" id="team"><div class="wrap">
  <div style="max-width:640px"><div class="kicker">Who's behind it</div><h2 class="h2">Meet the pack.</h2>
  <p class="lead">A small team building the outreach tool we wished existed, with four-legged supervisors.</p></div>
  <div class="teamgrid">
    <div class="member"><div class="slot ph" style="height:260px"><div class="t"><svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3"><circle cx="12" cy="9" r="3.4"/><path d="M5 20a7 7 0 0 1 14 0"/></svg>Photo</div></div><div class="nm">Kaitlyn Kasel</div><div class="rl">Founder</div></div>
    <div class="member"><div class="slot ph" style="height:260px"><div class="t"><svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3"><circle cx="12" cy="9" r="3.4"/><path d="M5 20a7 7 0 0 1 14 0"/></svg>Photo</div></div><div class="nm">Mera Kasel</div><div class="rl">Team</div></div>
    <div class="member"><div class="slot ph" style="height:260px"><div class="t"><svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3"><circle cx="12" cy="9" r="3.4"/><path d="M5 20a7 7 0 0 1 14 0"/></svg>Photo</div></div><div class="nm">Suri Kasel</div><div class="rl">Team</div></div>
  </div>
  <div class="pack">
    <div class="kicker" style="color:var(--muted)">Our scouts</div>
    <div class="packrow">
      <div class="slot p"><div class="t">Dog photo</div></div>
      <div class="slot p"><div class="t">Dog photo</div></div>
      <div class="slot p"><div class="t">Dog photo</div></div>
      <div class="slot p"><div class="t">Dog photo</div></div>
    </div>
  </div>
</div></section>

<!-- HELPS -->
<section class="sec" id="help" style="background:#EFE7D6"><div class="wrap">
  <div style="max-width:640px"><div class="kicker">Why it matters</div><h2 class="h2">Outreach that actually lands.</h2></div>
  <div class="statstrip">
    <div class="st"><div class="n">10×</div><h3>More replies</h3><p>Personal, specific messages beat generic blasts, every time.</p></div>
    <div class="st"><div class="n">~1 min</div><h3>Per person</h3><p>Find, research, and draft in about a minute, not an afternoon.</p></div>
    <div class="st"><div class="n">Zero</div><h3>Fake contacts</h3><p>Every name is real and pulled from the public web. Never invented.</p></div>
  </div>
</div></section>

<!-- CONTACT -->
<section class="contact" id="contact"><div class="wrap inner">
  <div>
    <div class="kicker k">Contact us</div>
    <h2>Let's find <em>your people</em>.</h2>
    <p>Questions, press, or partnerships? Send a note and we'll get back within a day.</p>
    <div class="em">Or email <b>hello@scout-source.com</b></div>
  </div>
  <div class="form">
    <div class="two"><input class="inp" placeholder="Your name"><input class="inp" placeholder="Email"></div>
    <textarea class="inp" placeholder="What can we help with?"></textarea>
    <a class="btn btn-t send" href="mailto:hello@scout-source.com">Send message →</a>
  </div>
</div></section>

<footer><div class="wrap"><div class="foot">
  <div class="brand"><img src="/scout-logo.png">Scout</div>
  <span>Reach the right people, in your own voice.</span>
  <div class="links"><a href="#uses">Uses</a><a href="#steps">Get started</a><a href="#contact">Contact</a></div>
</div></div></footer>

`;

export default function Landing() {
  return (
    <div className={`scoutland ${anton.variable} ${bric.variable} ${inter.variable}`}>
      <style dangerouslySetInnerHTML={{ __html: CSS }} />
      <div dangerouslySetInnerHTML={{ __html: BODY }} />
      <LandingMotion />
    </div>
  );
}
