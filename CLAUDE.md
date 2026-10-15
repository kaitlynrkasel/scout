# Scout (repo: cue-connect)

Scout streamlines outreach — finding the right people/opportunities and drafting
warm, personalized messages in the user's own voice. Verticals: Networking,
Job/Internship search, Music PR/Playlisting (adapts to any free-text use case).
Next.js 14 + Tailwind. Engine in `lib/` (Tavily search → Claude extract → draft),
UI in `app/app/page.tsx`. Optional Supabase auth + per-user state, Gmail OAuth.

## Collaborators
- **Kaitlyn** (GitHub `kaitlynrkasel`, repo owner) — collaborator.
- Project is a 50/50 collaboration.

## Design direction (in progress)
**Warm or white ONLY** (Kaitlyn's call, 2026-10-15): every cool tone (denim,
navy, teal, slate blue) is retired app-wide. The palette is warm browns,
creams, caramel, and white; the old blue/sage token names still exist but now
resolve to warm values, so never reintroduce cool hexes.
- The **app UI shares the landing page's editorial voice**: Bricolage Grotesque
  display headings (`--font-display`, applied to h1/h2/h3 + `.font-display`), Inter
  body, and uppercase dusty-blue **`.kicker`** eyebrows above section headers.
- Left **sidebar** is warm white paper with mixed-case labels, sentence-case
  group headers, tree-indented children, and a soft warm active pill
  (reference: Brainwave-style sidebar); the tab's idea colour lives on the
  icon only.
- The secondary accent is **warm chestnut/stone**: `blue`/`blue-deep`/
  `blue-tint`/`slate`/`sage` token NAMES remain for compatibility but resolve
  to warm values (chestnut #8A5A34 family), set in globals.css.
- Design tokens live in `tailwind.config.ts` + `app/globals.css`; older names
  (`coral`/`blush`/`accent`/`warm-*`/`blue`/`sage`) all remap to warm browns,
  so the whole app shifts palette centrally.
- The Scout **logo** is the owner's brushed dog-nose mark at `public/scout-logo.png`
  (also the favicon at `app/icon.png`). Every logo spot (sidebar, footer, landing
  nav, avatar) points at that one asset; to update the mark, replace that file,
  then run `python3 scripts/generate-pwa-icons.py` to redraw the home-screen icons
  derived from it (`app/apple-icon.png`, `public/icons/*`).
- Clickable design reference: `design/redesign-mock.html`.

## Installable (PWA)
Scout installs to a phone home screen and launches without browser chrome.
`app/manifest.ts` is the manifest (start_url `/app`, standalone, cream splash);
`public/sw.js` is the service worker (never caches `/api/*`, network-first pages
falling back to `app/offline/page.tsx`, cache-first hashed build assets) and is
registered by `app/pwa.tsx`, which also keeps `theme-color` in step with the
`.dark` class. Mobile chrome pads itself with `env(safe-area-inset-*)` because
`viewportFit: "cover"` lets the layout run under the notch. Bump `VERSION` in
`public/sw.js` to retire every old cache on a deploy.

## Fewest clicks to outreach
Scout's whole reason to exist is getting from "I need to reach someone" to a
drafted message, so **the Scout tab is the landing screen** — `tab` defaults to
`outreach`, and the mobile bar runs Scout · Finds · Dashboard · Templates ·
More, ordered by how often each is reached for. The dashboard is a look back at
work already done: somewhere you choose, not where you arrive. A refresh still
reopens whatever tab you were on, via the `#hash`.

## Shipping
Kaitlyn's standing call: **land it, don't ask.** Finished work goes all the way
in — commit, PR, merge to `main`, which deploys to scout-source.com — without
stopping for approval on the merge itself. Reverting a bad frontend change is
cheaper than a round trip, so bias to shipping. Still verify before pushing
(build, typecheck, whatever the change actually touches), still say plainly what
landed and what wasn't verified, and still ask first for anything a revert
can't undo: deleting data, sending mail from a real mailbox, or changes to
billing.
