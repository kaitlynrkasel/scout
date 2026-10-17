# Scout backlog

Queued features, picked by Kaitlyn. Work top-down unless she reorders.

## Autopilot per job project (2026-10-17, from Perplexity Computer comparison)
One button on a job-shaped project: run the search, keep everything above a
fit threshold, draft the application kit AND the outreach for each keeper,
then deliver ONE review digest (in-app + email) instead of making the user
walk scan, match, draft, review as separate steps. All the pieces exist
(auto-search, auto-draft, applications kit); this is the orchestration layer
plus a threshold setting and a digest.

## Posting watchers with deadline alerts (2026-10-17, same comparison)
Extend auto-search into watchers: track specific boards/companies/searches,
extract application deadlines from postings, and ping (email now, push
later) the moment a high-fit posting appears or a deadline nears. Builds on
the existing auto-search digests (supabase/auto_searches.sql) and the
postingWindow field already on Opportunity.

## Per-role resume tailoring (2026-10-17, same comparison, offered first)
In the Application kit: take the stored resume + this posting, produce an
ATS-shaped variant (job-description keywords mirrored, clean single-column
format), downloadable per find. Closes the biggest real gap to Perplexity
Computer's job agent.
