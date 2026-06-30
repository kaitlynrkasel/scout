# Scout — Phase 0 spike

A minimal web version of the Scout engine, proving the **one engine, multiple
templates** thesis: the same discover → find-contact → draft loop, switchable
between **Networking**, **Job / Internship Search**, and **Music PR**.

This is deliberately tiny — no auth, no database, one user. It exists to show the
engine running as a website before investing in the full multi-tenant build.

## What it does

1. Pick a template and describe your goal + yourself.
2. **Discover** — builds search queries, runs Tavily web search, and has Claude
   extract structured targets (name, contact, why-it-fits, fit score), deduped.
3. **Draft** — Claude writes channel-aware, voice-matched outreach for the rows
   you select. Email gets a full message; LinkedIn/handle gets a short note.
4. Read / copy the drafts.

Nothing sends. This is the discovery + drafting core only.

## How it maps to your Apps Script tools

| This spike | Your scripts |
|---|---|
| `lib/templates.ts` | `CONFIG_DEFAULTS` / `PROFILES` (the config object) |
| `lib/discover.ts` | `07_Discovery.gs` (buildQueries → tavily → claudeExtract → dedupe) |
| `lib/draft.ts` | `04_Drafting.gs` (`claudeDraft`, channel pick, no-em-dash) |
| `lib/claude.ts` | `claudeJson`, `parseJsonLoose`, `noDash` |
| `lib/tavily.ts` | `tavilySearch` |
| `app/api/*` | the menu actions, now as HTTP endpoints |

## Run it

```bash
cd ~/scout-web
npm install
cp .env.local.example .env.local   # then add your two keys
npm run dev
# open http://localhost:3000
```

You need the same two keys your Apps Script tools use:
`TAVILY_API_KEY` and `ANTHROPIC_API_KEY`.

## What Phase 1 adds (not here yet)

Auth, Postgres, per-user Gmail OAuth sending with TEST MODE + unsubscribe,
follow-up automation, inbox/reply tracking, the dashboard, and the deny/like
learning loop.
