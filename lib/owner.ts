// Owner-only backdoor for the Insights tab. Reads a comma-separated allowlist
// from the SCOUT_OWNER_EMAILS env var (case-insensitive). Anyone whose signed-in
// email isn't on the list is treated as a normal user, the tab is hidden and
// the admin API route rejects them.

function ownerEmails(): Set<string> {
  const raw = process.env.SCOUT_OWNER_EMAILS || "";
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  );
}

export function isOwnerEmail(email: string | undefined | null): boolean {
  if (!email) return false;
  return ownerEmails().has(String(email).trim().toLowerCase());
}
