"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";

export const dynamic = "force-dynamic";

interface DraftData {
  name: string;
  role: string;
  outlet: string;
  to: string;
  handle: string;
  url: string;
  canEmail: boolean;
  subject: string;
  draftBody: string;
}

function DraftInner() {
  const t = useSearchParams().get("t") || "";
  const [state, setState] = useState<"loading" | "ready" | "error" | "done">("loading");
  const [err, setErr] = useState("");
  const [d, setD] = useState<DraftData | null>(null);
  const [subject, setSubject] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState<"" | "send" | "draft">("");
  const [doneMsg, setDoneMsg] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!t) {
      setErr("Missing link token.");
      setState("error");
      return;
    }
    (async () => {
      try {
        const r = await fetch("/api/auto/draft", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ t }),
        });
        const j = await r.json();
        if (!r.ok || j?.error) {
          setErr(j?.error || "Couldn't load this draft.");
          setState("error");
          return;
        }
        setD(j);
        setSubject(j.subject || "");
        setMessage(j.draftBody || "");
        setState("ready");
      } catch (e: any) {
        setErr(e?.message || "Something went wrong.");
        setState("error");
      }
    })();
  }, [t]);

  async function submit(mode: "send" | "draft") {
    if (!message.trim() || busy) return;
    setBusy(mode);
    setErr("");
    try {
      const r = await fetch("/api/auto/send", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ t, mode, subject, body: message }),
      });
      const j = await r.json();
      if (!r.ok || j?.error) {
        setErr(j?.error || "That didn't go through.");
        setBusy("");
        return;
      }
      setDoneMsg(
        mode === "send"
          ? `Sent to ${d?.name || "your contact"} from your inbox.`
          : `Saved as a draft in your mailbox for ${d?.name || "your contact"}.`
      );
      setState("done");
    } catch (e: any) {
      setErr(e?.message || "Something went wrong.");
      setBusy("");
    }
  }

  async function copyMsg() {
    try {
      await navigator.clipboard.writeText((subject ? `Subject: ${subject}\n\n` : "") + message);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      /* ignore */
    }
  }

  const NAVY = "#13273F";
  const shell: React.CSSProperties = {
    minHeight: "100vh",
    background: "#F5F2EB",
    color: "#241C13",
    fontFamily:
      "-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,sans-serif",
    padding: "6vh 16px",
  };
  const card: React.CSSProperties = {
    maxWidth: 620,
    margin: "0 auto",
    background: "#fff",
    border: "1px solid #E7DFD2",
    borderRadius: 18,
    overflow: "hidden",
    boxShadow: "0 20px 50px -30px rgba(36,28,19,.28)",
  };

  if (state === "loading") {
    return (
      <div style={shell}>
        <div style={{ ...card, padding: 32, textAlign: "center" }}>
          <div style={{ fontSize: 14, color: "#57503f" }}>Drafting your message…</div>
        </div>
      </div>
    );
  }
  if (state === "error") {
    return (
      <div style={shell}>
        <div style={{ ...card, padding: 32, textAlign: "center" }}>
          <div style={{ fontSize: 30 }}>•</div>
          <h1 style={{ fontSize: 19, margin: "12px 0 6px", color: "#9E3F1F" }}>Couldn&apos;t open this</h1>
          <p style={{ fontSize: 14, color: "#57503f", lineHeight: 1.5 }}>{err}</p>
          <a href="/app" style={{ display: "inline-block", marginTop: 16, background: NAVY, color: "#fff", fontWeight: 700, fontSize: 14, textDecoration: "none", padding: "11px 20px", borderRadius: 10 }}>
            Open Scout
          </a>
        </div>
      </div>
    );
  }
  if (state === "done") {
    return (
      <div style={shell}>
        <div style={{ ...card, padding: 32, textAlign: "center" }}>
          <div style={{ fontSize: 34, color: "#5F6247" }}>✓</div>
          <h1 style={{ fontSize: 20, margin: "12px 0 6px" }}>{busy === "draft" ? "Saved" : "Sent"}</h1>
          <p style={{ fontSize: 14, color: "#57503f", lineHeight: 1.5 }}>{doneMsg}</p>
          <a href="/app" style={{ display: "inline-block", marginTop: 16, background: NAVY, color: "#fff", fontWeight: 700, fontSize: 14, textDecoration: "none", padding: "11px 20px", borderRadius: 10 }}>
            Open Scout
          </a>
        </div>
      </div>
    );
  }

  const inputStyle: React.CSSProperties = {
    width: "100%",
    boxSizing: "border-box",
    border: "1px solid #DED6C7",
    borderRadius: 10,
    padding: "10px 12px",
    fontSize: 14,
    color: "#241C13",
    outline: "none",
    fontFamily: "inherit",
    background: "#fff",
  };

  return (
    <div style={shell}>
      <div style={card}>
        <div style={{ background: NAVY, padding: "16px 22px" }}>
          <span style={{ color: "#fff", fontSize: 18, fontWeight: 800 }}>Scout</span>
          <span style={{ color: "#9FB0C6", fontSize: 13, fontWeight: 600, marginLeft: 8 }}>review &amp; send</span>
        </div>
        <div style={{ padding: "20px 22px 24px" }}>
          <div style={{ fontSize: 17, fontWeight: 800 }}>
            {d?.name}
            {d?.role ? <span style={{ color: "#8A8172", fontWeight: 600 }}> · {d.role}</span> : null}
          </div>
          {d?.outlet ? <div style={{ fontSize: 13, color: "#8A8172", marginTop: 2 }}>{d.outlet}</div> : null}
          <div style={{ fontSize: 12, color: "#8A8172", marginTop: 6, wordBreak: "break-all" }}>
            {d?.canEmail ? `To: ${d?.to}` : d?.handle || d?.url || "No email on file"}
          </div>

          {!d?.canEmail && (
            <div style={{ marginTop: 14, background: "#FBF3E7", border: "1px solid #EBD9BC", borderRadius: 10, padding: "10px 12px", fontSize: 12.5, color: "#7A5B1E", lineHeight: 1.5 }}>
              This contact has no email on file, so Scout can&apos;t auto-send. Edit
              the message below and copy it to reach out on their channel.
            </div>
          )}

          {d?.canEmail && (
            <div style={{ marginTop: 16 }}>
              <label style={{ fontSize: 11, fontWeight: 700, letterSpacing: ".04em", color: "#8A8172", textTransform: "uppercase" }}>Subject</label>
              <input value={subject} onChange={(e) => setSubject(e.target.value)} style={{ ...inputStyle, marginTop: 6 }} />
            </div>
          )}

          <div style={{ marginTop: 14 }}>
            <label style={{ fontSize: 11, fontWeight: 700, letterSpacing: ".04em", color: "#8A8172", textTransform: "uppercase" }}>Message</label>
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows={12}
              style={{ ...inputStyle, marginTop: 6, resize: "vertical", lineHeight: 1.55 }}
            />
          </div>

          {err && <div style={{ marginTop: 12, fontSize: 13, color: "#9E3F1F", fontWeight: 600 }}>{err}</div>}

          <div style={{ marginTop: 18, display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10 }}>
            {d?.canEmail ? (
              <>
                <button
                  onClick={() => submit("send")}
                  disabled={!!busy || !message.trim()}
                  style={{ background: NAVY, color: "#fff", fontSize: 14, fontWeight: 700, border: 0, borderRadius: 10, padding: "12px 24px", cursor: "pointer", opacity: busy ? 0.6 : 1 }}
                >
                  {busy === "send" ? "Sending…" : "Send"}
                </button>
                <button
                  onClick={() => submit("draft")}
                  disabled={!!busy || !message.trim()}
                  style={{ background: "#fff", color: "#57503f", fontSize: 13, fontWeight: 700, border: "1px solid #DED6C7", borderRadius: 10, padding: "11px 18px", cursor: "pointer", opacity: busy ? 0.6 : 1 }}
                >
                  {busy === "draft" ? "Saving…" : "Save as draft"}
                </button>
              </>
            ) : (
              <button
                onClick={copyMsg}
                style={{ background: NAVY, color: "#fff", fontSize: 14, fontWeight: 700, border: 0, borderRadius: 10, padding: "12px 24px", cursor: "pointer" }}
              >
                {copied ? "Copied ✓" : "Copy message"}
              </button>
            )}
            <a href="/app" style={{ marginLeft: "auto", color: "#8A8172", fontSize: 12.5, fontWeight: 600, textDecoration: "none" }}>
              Open Scout →
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function AutoDraftPage() {
  return (
    <Suspense fallback={<div style={{ minHeight: "100vh", background: "#F5F2EB" }} />}>
      <DraftInner />
    </Suspense>
  );
}
