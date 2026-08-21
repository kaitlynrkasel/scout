// The model has no clock. Left to itself it dates everything from its training
// data — which is how a 2026 internship search offered "Summer 2025" and
// "School year 2025-26" as its time-window options, both already over. Any
// prompt that reasons about dates, terms or seasons gets this line.
//
// Shared rather than repeated so the planner, the extractor and the drafts
// can't drift into disagreeing about what year it is.
export function todayLine(): string {
  const now = new Date();
  return (
    `TODAY'S DATE: ${now.toISOString().slice(0, 10)} (year ${now.getFullYear()}). ` +
    `Never propose, ask about, or plan for a date, term, semester, season or year that has already passed — ` +
    `every time window you offer must be the current one or a future one, counted from the date above and not ` +
    `from anything you remember. When a goal names a term ("fall 2026", "next summer"), anchor to that; when it ` +
    `doesn't, offer windows starting from today.`
  );
}
