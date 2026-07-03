// Business-hours + timezone helpers for send guidance. Client-safe (Intl only,
// no deps). Business hours = Mon-Fri, 9am-5pm in the recipient's timezone. When we
// can't confidently determine a timezone we return "" and callers just send (never
// block on a guess).

const BIZ_START = 9; // 9am
const BIZ_END = 17; // 5pm (17:00)

const US_STATE_TZ: Record<string, string> = {
  // Eastern
  ct: "America/New_York", de: "America/New_York", fl: "America/New_York",
  ga: "America/New_York", in: "America/New_York", ky: "America/New_York",
  me: "America/New_York", md: "America/New_York", ma: "America/New_York",
  mi: "America/New_York", nh: "America/New_York", nj: "America/New_York",
  ny: "America/New_York", nc: "America/New_York", oh: "America/New_York",
  pa: "America/New_York", ri: "America/New_York", sc: "America/New_York",
  vt: "America/New_York", va: "America/New_York", wv: "America/New_York",
  dc: "America/New_York",
  // Central
  al: "America/Chicago", ar: "America/Chicago", il: "America/Chicago",
  ia: "America/Chicago", ks: "America/Chicago", la: "America/Chicago",
  mn: "America/Chicago", ms: "America/Chicago", mo: "America/Chicago",
  ne: "America/Chicago", nd: "America/Chicago", ok: "America/Chicago",
  sd: "America/Chicago", tn: "America/Chicago", tx: "America/Chicago",
  wi: "America/Chicago",
  // Mountain
  co: "America/Denver", id: "America/Denver", mt: "America/Denver",
  nm: "America/Denver", ut: "America/Denver", wy: "America/Denver",
  az: "America/Phoenix",
  // Pacific / other
  ca: "America/Los_Angeles", nv: "America/Los_Angeles", or: "America/Los_Angeles",
  wa: "America/Los_Angeles", ak: "America/Anchorage", hi: "Pacific/Honolulu",
};

const CITY_TZ: Record<string, string> = {
  "new york": "America/New_York", brooklyn: "America/New_York",
  nashville: "America/Chicago", "los angeles": "America/Los_Angeles",
  "san francisco": "America/Los_Angeles", chicago: "America/Chicago",
  austin: "America/Chicago", seattle: "America/Los_Angeles",
  boston: "America/New_York", atlanta: "America/New_York",
  miami: "America/New_York", denver: "America/Denver",
  london: "Europe/London", paris: "Europe/Paris", berlin: "Europe/Berlin",
  amsterdam: "Europe/Amsterdam", toronto: "America/Toronto",
  vancouver: "America/Vancouver", sydney: "Australia/Sydney",
  melbourne: "Australia/Melbourne", tokyo: "Asia/Tokyo",
};

const COUNTRY_TZ: Record<string, string> = {
  uk: "Europe/London", "united kingdom": "Europe/London", england: "Europe/London",
  scotland: "Europe/London", ireland: "Europe/Dublin", canada: "America/Toronto",
  australia: "Australia/Sydney", germany: "Europe/Berlin", france: "Europe/Paris",
  netherlands: "Europe/Amsterdam", japan: "Asia/Tokyo",
};

// Best-effort IANA timezone from a free-text location. "" when unknown.
export function guessTimezone(location?: string): string {
  const s = String(location || "").toLowerCase();
  if (!s.trim()) return "";
  for (const c of Object.keys(CITY_TZ)) if (s.includes(c)) return CITY_TZ[c];
  const st =
    (s.match(/,\s*([a-z]{2})\b/) || [])[1] ||
    (s.match(/\b([a-z]{2})\s+\d{5}\b/) || [])[1];
  if (st && US_STATE_TZ[st]) return US_STATE_TZ[st];
  for (const c of Object.keys(COUNTRY_TZ)) if (s.includes(c)) return COUNTRY_TZ[c];
  return "";
}

function partsIn(tz: string, date: Date) {
  const dp = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "2-digit",
    hourCycle: "h23",
    weekday: "short",
  }).formatToParts(date);
  const hour = parseInt(dp.find((p) => p.type === "hour")?.value || "0", 10);
  const wdName = dp.find((p) => p.type === "weekday")?.value || "Mon";
  const wdIdx = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(wdName);
  return { hour, wdIdx };
}

// Unknown tz returns true (don't block on a guess).
export function isBusinessHours(tz: string, date = new Date()): boolean {
  if (!tz) return true;
  const { hour, wdIdx } = partsIn(tz, date);
  return wdIdx >= 1 && wdIdx <= 5 && hour >= BIZ_START && hour < BIZ_END;
}

// The recipient's current local time, e.g. "3:12 AM". "" if tz unknown.
export function localTimeLabel(tz: string, date = new Date()): string {
  if (!tz) return "";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(date);
}

// A friendly label for the next business-hours window in that tz, e.g.
// "today 9 AM", "tomorrow 9 AM", "Monday 9 AM". "" if tz unknown.
export function nextBusinessLabel(tz: string, date = new Date()): string {
  if (!tz) return "";
  const { hour, wdIdx } = partsIn(tz, date);
  const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  if (wdIdx >= 1 && wdIdx <= 5 && hour < BIZ_START) return "today 9 AM";
  let add = 1;
  let wi = wdIdx;
  while (true) {
    wi = (wi + 1) % 7;
    if (wi >= 1 && wi <= 5) break;
    add++;
  }
  const rel = add === 1 ? "tomorrow" : days[wi];
  return `${rel} 9 AM`;
}
