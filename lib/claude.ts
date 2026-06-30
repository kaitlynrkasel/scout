// Anthropic wrapper + the loose-JSON parser, ported from claudeJson() and
// parseJsonLoose() in your scripts (07_Discovery.gs). No SDK needed — one fetch.

import { classifyApiError } from "./apiErrors";

const MODEL = process.env.SCOUT_MODEL || "claude-sonnet-4-6";

export async function claudeJson(system: string, user: string): Promise<string> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY is not set");
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1024,
      system,
      messages: [{ role: "user", content: user }],
    }),
  });
  const body = await res.json();
  if (!res.ok) {
    const msg = body?.error?.message || "request failed";
    const credit = classifyApiError("Anthropic", res.status, msg);
    if (credit) throw credit;
    throw new Error(`Anthropic ${res.status}: ${msg}`);
  }
  return body?.content?.[0]?.text || "";
}

// Tolerant JSON extraction: models sometimes wrap JSON in prose or leave raw
// newlines inside string values. Mirrors parseJsonLoose + the control-char fix.
export function parseJsonLoose<T = any>(text: string): T | null {
  if (!text) return null;
  const a = text.indexOf("{");
  const b = text.lastIndexOf("}");
  if (a < 0 || b < a) return null;
  const slice = text.slice(a, b + 1);
  try {
    return JSON.parse(slice) as T;
  } catch {
    try {
      return JSON.parse(escapeRawControlCharsInJsonStrings(slice)) as T;
    } catch {
      return null;
    }
  }
}

function escapeRawControlCharsInJsonStrings(s: string): string {
  let out = "";
  let inStr = false;
  let esc = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (esc) {
      out += ch;
      esc = false;
      continue;
    }
    if (ch === "\\") {
      out += ch;
      esc = true;
      continue;
    }
    if (ch === '"') {
      inStr = !inStr;
      out += ch;
      continue;
    }
    if (inStr) {
      if (ch === "\n") {
        out += "\\n";
        continue;
      }
      if (ch === "\r") {
        out += "\\r";
        continue;
      }
      if (ch === "\t") {
        out += "\\t";
        continue;
      }
    }
    out += ch;
  }
  return out;
}

// Strip em/en dashes from anything that goes out — a dead giveaway of AI writing.
// Ported from noDash() in 17_Email.gs.
export function noDash(s: string): string {
  return String(s == null ? "" : s).replace(/\s*[‒–—―−]\s*/g, ", ");
}
