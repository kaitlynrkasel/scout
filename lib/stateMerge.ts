// Merging two copies of one user's app state.
//
// Scout keeps everything a user has (projects, categories, finds, templates,
// activity) in ONE JSON blob per account — `user_state.data`. That blob is
// written wholesale, which is fine with a single tab open and wrong the moment
// the same account is open on a laptop and a phone: whichever device saved last
// replaced the other's work, and neither ever re-read the row after boot. A
// search run on the laptop simply did not exist on the phone.
//
// So devices now re-read the row (on focus, on an interval, on a realtime
// nudge) and fold what they find into what they already have, instead of
// picking a winner. The rules below are deliberately boring:
//
//   - Collections of things with ids (finds, projects, templates, …) UNION by
//     id. A row only one side knows about is kept, never dropped — that is what
//     makes the merge safe to run on an older device.
//   - When both sides hold the same id, the more-progressed copy wins (a find
//     that has been sent beats the same find still sitting at "new"), falling
//     back to whichever was touched later.
//   - Counters take the per-key maximum; they only ever go up.
//   - Deletions are explicit. A deleted id is remembered in `deleted` and
//     applied after the union, so a find removed on the phone does not come
//     back from the laptop's older copy. Without tombstones a union merge can
//     never honour a delete.
//
// Everything here is pure and side-effect free so it can be reasoned about (and
// tested) without React, storage or a network in the picture.

import type { AppState } from "./supabase";

type Row = Record<string, any>;

/** Ids of rows a device has deliberately removed, so a union can honour it. */
export interface Tombstones {
  projects: string[];
  categories: string[];
  finds: string[];
}

export const EMPTY_TOMBSTONES: Tombstones = { projects: [], categories: [], finds: [] };

// Tombstone lists are unbounded in principle and bounded in practice: an id is
// ~40 bytes and the blob has to stay small enough to write on every edit.
const TOMBSTONE_CAP = 500;
// Mirrors the caps the app already applies when it writes these itself, so a
// merge can't quietly grow a list past what the drafting code expects.
const COACHING_CAP = 8;
const EDIT_PAIRS_CAP = 6;

const asArray = (v: unknown): Row[] => (Array.isArray(v) ? (v as Row[]).filter(Boolean) : []);
const idOf = (r: Row): string => String(r?.id ?? "");
const strList = (v: unknown): string[] =>
  Array.isArray(v) ? v.map((x) => String(x)).filter(Boolean) : [];

/**
 * Union two id-keyed collections. `local` order is preserved and rows only
 * `remote` has are appended, so a merge never reshuffles what the user is
 * looking at. `prefer` decides collisions.
 */
function unionById(
  local: Row[],
  remote: Row[],
  prefer: (mine: Row, theirs: Row) => Row = (_mine, theirs) => theirs
): Row[] {
  const out: Row[] = [];
  const seen = new Map<string, number>(); // id → index in `out`
  for (const row of local) {
    const id = idOf(row);
    if (!id || seen.has(id)) continue;
    seen.set(id, out.length);
    out.push(row);
  }
  for (const row of remote) {
    const id = idOf(row);
    if (!id) continue;
    const at = seen.get(id);
    if (at === undefined) {
      seen.set(id, out.length);
      out.push(row);
    } else {
      out[at] = prefer(out[at], row);
    }
  }
  return out;
}

// How far along the outreach a find is. A copy that has been sent or replied to
// is strictly more interesting than the same person still unreviewed, whatever
// the clocks on the two devices say.
const FIND_PROGRESS: Record<string, number> = {
  new: 0,
  undecided: 1,
  denied: 2,
  drafted: 3,
  sent: 4,
  replied: 5,
};

/** Last time anything actually happened to a find, by its own timestamps. */
function findTouchedAt(f: Row): number {
  return Math.max(
    Number(f?.lastFollowUpAt) || 0,
    Number(f?.sentAt) || 0,
    Number(f?.draftedAt) || 0,
    Number(f?.addedAt) || 0
  );
}

/**
 * Same person on both devices: keep the copy that has got further, then the one
 * touched more recently, then the one carrying a draft. Ties go to `theirs`,
 * which is the copy that was written to the account more recently.
 */
export function preferFind(mine: Row, theirs: Row): Row {
  const mp = FIND_PROGRESS[String(mine?.status)] ?? 0;
  const tp = FIND_PROGRESS[String(theirs?.status)] ?? 0;
  if (mp !== tp) return mp > tp ? mine : theirs;
  const mt = findTouchedAt(mine);
  const tt = findTouchedAt(theirs);
  if (mt !== tt) return mt > tt ? mine : theirs;
  const mineHasDraft = !!mine?.draft?.body;
  const theirsHasDraft = !!theirs?.draft?.body;
  if (mineHasDraft !== theirsHasDraft) return mineHasDraft ? mine : theirs;
  return theirs;
}

/** Counters never regress: take the larger of each key. */
function mergeActivity(mine: any, theirs: any): any {
  const out: Record<string, any> = { ...(mine || {}) };
  for (const [k, v] of Object.entries(theirs || {})) {
    const a = Number(out[k]);
    const b = Number(v);
    if (Number.isFinite(b)) out[k] = Math.max(Number.isFinite(a) ? a : 0, b);
    else if (out[k] === undefined) out[k] = v;
  }
  return out;
}

/** Union of short string lists (coaching tips), case-insensitive, local first. */
function mergeTips(mine: string[], theirs: string[], cap: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const t of [...mine, ...theirs]) {
    const key = t.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out.slice(0, cap);
}

function mergeEditPairs(
  mine: { before: string; after: string }[],
  theirs: { before: string; after: string }[]
): { before: string; after: string }[] {
  const out: { before: string; after: string }[] = [];
  const seen = new Set<string>();
  for (const p of [...mine, ...theirs]) {
    if (!p || typeof p.before !== "string" || typeof p.after !== "string") continue;
    const key = `${p.before}\u0000${p.after}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out.slice(0, EDIT_PAIRS_CAP);
}

/** A blank remote value must never shadow a real local one (see boot merge). */
function mergeExtras(mine: any, theirs: any): any {
  const out: Record<string, any> = { ...(mine || {}) };
  for (const [k, v] of Object.entries(theirs || {})) {
    if (v !== "" && v !== undefined && v !== null) out[k] = v;
  }
  return out;
}

export function readTombstones(v: unknown): Tombstones {
  const raw = (v || {}) as Row;
  return {
    projects: strList(raw.projects),
    categories: strList(raw.categories),
    finds: strList(raw.finds),
  };
}

export function mergeTombstones(mine: Tombstones, theirs: Tombstones): Tombstones {
  const join = (a: string[], b: string[]) =>
    Array.from(new Set([...a, ...b])).slice(-TOMBSTONE_CAP);
  return {
    projects: join(mine.projects, theirs.projects),
    categories: join(mine.categories, theirs.categories),
    finds: join(mine.finds, theirs.finds),
  };
}

export const hasTombstones = (t: Tombstones) =>
  t.projects.length > 0 || t.categories.length > 0 || t.finds.length > 0;

/**
 * Drop everything either device has deleted. Deleting a project takes its
 * categories and finds with it, exactly as `removeProject` does locally, so a
 * project that was deleted elsewhere doesn't leave orphaned rows behind.
 */
export function applyTombstones<T extends Pick<AppState, "projects" | "categories" | "finds">>(
  state: T,
  gone: Tombstones
): T {
  if (!hasTombstones(gone)) return state;
  const goneP = new Set(gone.projects);
  const goneC = new Set(gone.categories);
  const goneF = new Set(gone.finds);
  return {
    ...state,
    projects: asArray(state.projects).filter((p) => !goneP.has(idOf(p))),
    categories: asArray(state.categories).filter(
      (c) => !goneC.has(idOf(c)) && !goneP.has(String(c.projectId))
    ),
    finds: asArray(state.finds).filter(
      (f) => !goneF.has(idOf(f)) && !goneP.has(String(f.projectId))
    ),
  };
}

/**
 * Fold the account's copy of the state (`remote`) into this device's copy
 * (`local`). Union-based and tombstone-aware, so it is safe to run in either
 * direction and safe to run repeatedly — merging an already-merged state
 * returns the same content, which is what stops two devices pushing updates at
 * each other forever.
 */
export function mergeStates(local: AppState, remote: AppState): AppState {
  const gone = mergeTombstones(readTombstones(local.deleted), readTombstones(remote.deleted));
  const merged: AppState = {
    // Union by id. Collisions take the account's copy for plain settings rows
    // (it was written later), and the more-progressed copy for finds.
    projects: unionById(asArray(local.projects), asArray(remote.projects)),
    categories: unionById(asArray(local.categories), asArray(remote.categories)),
    templates: unionById(asArray(local.templates), asArray(remote.templates)),
    lists: unionById(asArray(local.lists), asArray(remote.lists)),
    syncedSheets: unionById(asArray(local.syncedSheets), asArray(remote.syncedSheets)),
    finds: unionById(asArray(local.finds), asArray(remote.finds), preferFind),
    activity: mergeActivity(local.activity, remote.activity),
    coaching: mergeTips(strList(local.coaching), strList(remote.coaching), COACHING_CAP),
    editPairs: mergeEditPairs(local.editPairs || [], remote.editPairs || []),
    // Which project is open is a per-device choice, not shared state — syncing
    // it would yank the phone onto whatever the laptop happens to have open.
    activeId: local.activeId || remote.activeId || "",
    resumeFile: local.resumeFile || remote.resumeFile || null,
    signature: (local.signature || "").trim() ? local.signature : remote.signature || "",
    profileExtras: mergeExtras(local.profileExtras, remote.profileExtras),
    deleted: gone,
  };
  return applyTombstones(merged, gone);
}
