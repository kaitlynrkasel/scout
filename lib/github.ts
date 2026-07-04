// Minimal GitHub Contents API client — used only by the auto-tune cron to
// read/write lib/discover.ts directly on main. Scoped to one repo, one token
// (GITHUB_AUTOTUNE_TOKEN), read via a fine-grained PAT with just
// "Contents: Read and write" on this repo — never the full account.

const OWNER = "kaitlynrkasel";
const REPO = "scout";
const API = `https://api.github.com/repos/${OWNER}/${REPO}`;

function authHeaders(): Record<string, string> {
  const token = process.env.GITHUB_AUTOTUNE_TOKEN || "";
  return {
    authorization: `Bearer ${token}`,
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
  };
}

export function githubConfigured(): boolean {
  return !!process.env.GITHUB_AUTOTUNE_TOKEN;
}

export async function getFile(path: string): Promise<{ content: string; sha: string }> {
  const res = await fetch(`${API}/contents/${encodeURIComponent(path)}?ref=main`, {
    headers: authHeaders(),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`GitHub GET ${path} failed: ${res.status}`);
  const data = await res.json();
  const content = Buffer.from(data.content, "base64").toString("utf-8");
  return { content, sha: data.sha };
}

export async function putFile(
  path: string,
  content: string,
  sha: string,
  message: string
): Promise<{ commitUrl: string; commitSha: string }> {
  const res = await fetch(`${API}/contents/${encodeURIComponent(path)}`, {
    method: "PUT",
    headers: { ...authHeaders(), "content-type": "application/json" },
    body: JSON.stringify({
      message,
      content: Buffer.from(content, "utf-8").toString("base64"),
      sha,
      branch: "main",
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`GitHub PUT ${path} failed: ${res.status} ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  return {
    commitUrl: data?.commit?.html_url || `https://github.com/${OWNER}/${REPO}/commits/main`,
    commitSha: data?.commit?.sha || "",
  };
}
