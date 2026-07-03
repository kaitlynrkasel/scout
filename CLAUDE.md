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
Rebrand to a **warm-brown + cream** palette, clean and inviting, not overwhelming.
- Left **sidebar** navigation; **Dashboard** is the landing screen.
- Sage is a secondary accent, used sparingly (nod to the logo's green).
- Design tokens live in `tailwind.config.ts` + `app/globals.css`; older names
  (`coral`/`blush`/`accent`/`warm-*`) are remapped to browns so the whole app
  shifts palette centrally.
- The Scout **logo** is the owner's brushed dog-nose mark at `public/scout-logo.png`
  (also the favicon at `app/icon.png`). Every logo spot (sidebar, footer, landing
  nav, avatar) points at that one asset; to update the mark, replace that file.
- Clickable design reference: `design/redesign-mock.html`.
