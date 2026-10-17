// Structured job-board adapters. Greenhouse, Lever, Ashby and Workable all
// publish their boards through open JSON endpoints; when a search surfaces
// ONE posting on a company's board, these read the company's WHOLE board in
// a single request: fresher and more complete than any web search, ours or
// anyone's. Results are shaped like search results so they flow through the
// same extraction, scoring and caps as every other candidate.

import type { TavilyResult } from "./tavily";

export interface BoardRef {
  kind: "greenhouse" | "lever" | "ashby" | "workable";
  token: string; // the company slug on that board
}

export function detectBoard(url: string): BoardRef | null {
  const m = (re: RegExp) => re.exec(url || "")?.[1]?.toLowerCase() || "";
  let t = m(/(?:boards|job-boards)\.greenhouse\.io\/([a-z0-9-_]+)/i);
  if (t) return { kind: "greenhouse", token: t };
  t = m(/jobs\.lever\.co\/([a-z0-9-_]+)/i);
  if (t) return { kind: "lever", token: t };
  t = m(/jobs\.ashbyhq\.com\/([a-z0-9-_%.]+)/i);
  if (t) return { kind: "ashby", token: t };
  t = m(/apply\.workable\.com\/([a-z0-9-_]+)/i);
  if (t && t !== "api") return { kind: "workable", token: t };
  return null;
}

const CAP = 40; // postings per board; plenty for matching without flooding

async function getJson(url: string, init?: RequestInit): Promise<any | null> {
  try {
    const res = await fetch(url, init);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export async function fetchBoardPostings(b: BoardRef): Promise<TavilyResult[]> {
  if (b.kind === "greenhouse") {
    const data = await getJson(
      `https://boards-api.greenhouse.io/v1/boards/${b.token}/jobs?content=true`
    );
    return ((data?.jobs || []) as any[]).slice(0, CAP).map((j) => ({
      title: `${j.title} — ${b.token}`,
      url: String(j.absolute_url || ""),
      content: [
        j.location?.name && `Location: ${j.location.name}`,
        j.departments?.[0]?.name && `Team: ${j.departments[0].name}`,
        String(j.content || "")
          .replace(/<[^>]+>/g, " ")
          .replace(/&[a-z]+;/g, " ")
          .replace(/\s+/g, " ")
          .slice(0, 900),
      ]
        .filter(Boolean)
        .join(". "),
    }));
  }
  if (b.kind === "lever") {
    const data = await getJson(`https://api.lever.co/v0/postings/${b.token}?mode=json`);
    return ((Array.isArray(data) ? data : []) as any[]).slice(0, CAP).map((j) => ({
      title: `${j.text} — ${b.token}`,
      url: String(j.hostedUrl || ""),
      content: [
        j.categories?.location && `Location: ${j.categories.location}`,
        j.categories?.team && `Team: ${j.categories.team}`,
        String(j.descriptionPlain || "").slice(0, 900),
      ]
        .filter(Boolean)
        .join(". "),
    }));
  }
  if (b.kind === "ashby") {
    const data = await getJson(
      `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(b.token)}`
    );
    return ((data?.jobs || []) as any[]).slice(0, CAP).map((j) => ({
      title: `${j.title} — ${b.token}`,
      url: String(j.jobUrl || j.applyUrl || ""),
      content: [
        j.location && `Location: ${j.location}`,
        j.department && `Team: ${j.department}`,
        j.isRemote ? "Remote" : "",
      ]
        .filter(Boolean)
        .join(". "),
    }));
  }
  // workable
  const data = await getJson(
    `https://apply.workable.com/api/v1/widget/accounts/${b.token}?details=false`
  );
  return ((data?.jobs || []) as any[]).slice(0, CAP).map((j) => ({
    title: `${j.title} — ${b.token}`,
    url: String(j.url || j.shortlink || ""),
    content: [
      (j.city || j.country) && `Location: ${[j.city, j.country].filter(Boolean).join(", ")}`,
      j.department && `Team: ${j.department}`,
    ]
      .filter(Boolean)
      .join(". "),
  }));
}

// Loose role matching: a board dump of 40 postings narrows to the ones that
// share words with the goal; with no usable goal words, the board's postings
// pass through and extraction judges fit as usual.
export function goalRoleWords(goal: string): string[] {
  const STOP = new Set(
    "the and for with that this from into open jobs job roles role positions position hiring apply application applications internship internships intern summer fall spring remote near who are has have must will can may".split(
      " "
    )
  );
  return (goal.toLowerCase().match(/[a-z]{4,}/g) || []).filter((w) => !STOP.has(w)).slice(0, 12);
}

export function matchPostings(postings: TavilyResult[], goal: string): TavilyResult[] {
  const words = goalRoleWords(goal);
  if (!words.length) return postings;
  const hit = postings.filter((p) => {
    const t = `${p.title} ${p.content}`.toLowerCase();
    return words.some((w) => t.includes(w));
  });
  return hit.length ? hit : postings;
}
