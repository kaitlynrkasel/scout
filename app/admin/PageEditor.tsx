"use client";

// The full editable preview: Scout's surfaces registered as drag-and-drop
// blocks in Puck (puckeditor.com), the embeddable visual editor the research
// pointed at. Every block exposes every one of its colors as a field, blocks
// drag anywhere in any order, grounds nest other blocks, and the arrangement
// saves on this device and exports as JSON for engineering. Nothing here
// touches the live site; it is the design table, not the printing press.

import { useEffect, useMemo, useState } from "react";
import { Puck, DropZone, type Config, type Data } from "@measured/puck";

const colorField = (label: string) => ({ type: "text" as const, label: `${label} (hex)` });

const config: Config = {
  components: {
    LandingHero: {
      label: "Landing hero",
      fields: {
        kicker: { type: "text" },
        heading: { type: "text" },
        sub: { type: "textarea" },
        ctaText: { type: "text" },
        secondaryText: { type: "text" },
        bg: colorField("Background"),
        ink: colorField("Text"),
        buttonBg: colorField("Button"),
        buttonText: colorField("Button text"),
      },
      defaultProps: {
        kicker: "FIND · TRACK · DRAFT",
        heading: "Find your people.",
        sub: "Scout finds who to reach and writes the first note in your voice.",
        ctaText: "Start free",
        secondaryText: "See how it works",
        bg: "#f8f7f5",
        ink: "#2b2723",
        buttonBg: "#5c4634",
        buttonText: "#f6efe6",
      },
      render: ({ kicker, heading, sub, ctaText, secondaryText, bg, ink, buttonBg, buttonText }) => (
        <div style={{ background: bg, color: ink, padding: "56px 48px" }}>
          <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: "0.14em", opacity: 0.55 }}>{kicker}</div>
          <div className="font-display" style={{ fontSize: 44, fontWeight: 800, letterSpacing: "-0.02em", marginTop: 8 }}>
            {heading}
          </div>
          <p style={{ marginTop: 10, maxWidth: 520, opacity: 0.75, lineHeight: 1.55 }}>{sub}</p>
          <div style={{ display: "flex", gap: 12, marginTop: 20, flexWrap: "wrap" }}>
            <span style={{ background: buttonBg, color: buttonText, borderRadius: 999, padding: "12px 26px", fontWeight: 700 }}>{ctaText}</span>
            <span style={{ border: `1px solid ${ink}33`, borderRadius: 999, padding: "12px 26px", fontWeight: 600 }}>{secondaryText}</span>
          </div>
        </div>
      ),
    },
    StageComposer: {
      label: "Scout composer",
      fields: {
        project: { type: "text" },
        category: { type: "text" },
        bullets: { type: "textarea", label: "Bullets (one per line)" },
        bg: colorField("Ground"),
        cream: colorField("Cream"),
        buttonText: colorField("Button text"),
      },
      defaultProps: {
        project: "Scout",
        category: "Companies",
        bullets: "Companies across many industries\nAny location\nSmaller companies preferred\nProspects to pitch to",
        bg: "#5c4634",
        cream: "#f6efe6",
        buttonText: "#4a3729",
      },
      render: ({ project, category, bullets, bg, cream, buttonText }) => (
        <div style={{ background: bg, color: cream, padding: "40px 48px" }}>
          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: "0.14em", opacity: 0.55 }}>SCOUTING FOR</span>
            {[project, category].map((t: string) => (
              <span key={t} style={{ border: "1px solid rgba(255,255,255,.25)", background: "rgba(255,255,255,.09)", borderRadius: 999, padding: "8px 18px", fontWeight: 600 }}>
                {t}
              </span>
            ))}
          </div>
          <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: "0.14em", opacity: 0.55, marginTop: 22 }}>THIS SEARCH FINDS</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px 48px", marginTop: 12, maxWidth: 760 }}>
            {String(bullets).split("\n").filter(Boolean).map((b: string) => (
              <span key={b} style={{ display: "flex", gap: 10, fontWeight: 600, fontSize: 17 }}>
                <span style={{ width: 7, height: 7, borderRadius: 99, background: cream, marginTop: 8, flexShrink: 0, opacity: 0.85 }} />
                {b}
              </span>
            ))}
          </div>
          <span style={{ display: "inline-block", background: cream, color: buttonText, borderRadius: 999, padding: "12px 30px", fontWeight: 700, marginTop: 24 }}>
            Scout
          </span>
        </div>
      ),
    },
    StatBand: {
      label: "Stat band",
      fields: {
        items: { type: "textarea", label: "Stats (value|label per line)" },
        bg: colorField("Ground"),
        numberColor: colorField("Numbers"),
        labelColor: colorField("Labels"),
      },
      defaultProps: {
        items: "45|Finds\n12|Messages sent\n18%|Reply rate\n50%|On-target\n21|Searches run\n4|Hours saved",
        bg: "#4a3729",
        numberColor: "#f6efe6",
        labelColor: "#c9bcae",
      },
      render: ({ items, bg, numberColor, labelColor }) => (
        <div style={{ background: bg, display: "grid", gridTemplateColumns: "repeat(6, 1fr)", gap: 1, padding: 1 }}>
          {String(items).split("\n").filter(Boolean).map((line: string) => {
            const [v, l] = line.split("|");
            return (
              <div key={line} style={{ background: "rgba(255,255,255,.05)", padding: "24px 20px" }}>
                <div className="font-display" style={{ fontSize: 32, fontWeight: 700, color: numberColor }}>{v}</div>
                <div style={{ fontSize: 11, marginTop: 6, color: labelColor }}>{l}</div>
              </div>
            );
          })}
        </div>
      ),
    },
    FindCard: {
      label: "Find card",
      fields: {
        name: { type: "text" },
        role: { type: "text" },
        tileColor: colorField("Tile"),
        cardBg: colorField("Card"),
        ink: colorField("Text"),
        fitLabel: { type: "select", options: ["Perfect fit", "Great fit", "Good fit", "Potential fit", "Far-fetched fit"].map((v) => ({ label: v, value: v })) },
        fitBg: colorField("Fit pill"),
        fitText: colorField("Fit pill text"),
      },
      defaultProps: {
        name: "Kinkead Entertainment",
        role: "CEO and Talent Agent, Nashville TN",
        tileColor: "#377ec0",
        cardBg: "#ffffff",
        ink: "#2b2723",
        fitLabel: "Great fit",
        fitBg: "#e2ece5",
        fitText: "#3f6b4f",
      },
      render: ({ name, role, tileColor, cardBg, ink, fitLabel, fitBg, fitText }) => (
        <div style={{ padding: 24, display: "flex", justifyContent: "center" }}>
          <div style={{ background: cardBg, color: ink, borderRadius: 16, overflow: "hidden", width: 360, boxShadow: "0 10px 28px rgba(0,0,0,.12)" }}>
            <div style={{ background: tileColor, height: 110, display: "grid", placeItems: "center" }}>
              <span style={{ background: "rgba(255,255,255,.85)", color: tileColor, borderRadius: 8, width: 34, height: 34, display: "grid", placeItems: "center", fontWeight: 800 }}>
                {String(name).slice(0, 1)}
              </span>
            </div>
            <div style={{ padding: 16 }}>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <b style={{ fontSize: 15 }}>{name}</b>
                <span style={{ marginLeft: "auto", background: fitBg, color: fitText, borderRadius: 999, fontSize: 10, fontWeight: 800, padding: "3px 9px" }}>{fitLabel}</span>
              </div>
              <div style={{ fontSize: 12, opacity: 0.6, marginTop: 4 }}>{role}</div>
            </div>
          </div>
        </div>
      ),
    },
    DogMark: {
      label: "Scout dog",
      fields: {
        color: colorField("Color"),
        size: { type: "number", label: "Width (px)" },
        align: { type: "radio", options: [{ label: "Left", value: "flex-start" }, { label: "Center", value: "center" }, { label: "Right", value: "flex-end" }] },
      },
      defaultProps: { color: "#f6efe6", size: 180, align: "center" },
      render: ({ color, size, align }) => (
        <div style={{ display: "flex", justifyContent: align, padding: 16 }}>
          <span
            aria-hidden
            style={{
              width: size,
              aspectRatio: "2048 / 1578",
              background: color,
              WebkitMaskImage: "url(/scout-dog.png)",
              maskImage: "url(/scout-dog.png)",
              WebkitMaskSize: "contain",
              maskSize: "contain",
              WebkitMaskRepeat: "no-repeat",
              maskRepeat: "no-repeat",
              display: "block",
            }}
          />
        </div>
      ),
    },
    TextBlock: {
      label: "Text",
      fields: {
        text: { type: "textarea" },
        size: { type: "number", label: "Size (px)" },
        weight: { type: "select", options: [400, 600, 700, 800].map((v) => ({ label: String(v), value: v })) },
        color: colorField("Color"),
        align: { type: "radio", options: [{ label: "Left", value: "left" }, { label: "Center", value: "center" }, { label: "Right", value: "right" }] },
      },
      defaultProps: { text: "Say it here.", size: 22, weight: 700, color: "#2b2723", align: "left" },
      render: ({ text, size, weight, color, align }) => (
        <div style={{ padding: "16px 48px", fontSize: size, fontWeight: weight as number, color, textAlign: align as any, lineHeight: 1.4 }}>{text}</div>
      ),
    },
    ButtonBlock: {
      label: "Button",
      fields: {
        label: { type: "text" },
        bg: colorField("Background"),
        color: colorField("Text"),
        shape: { type: "radio", options: [{ label: "Pill", value: 999 }, { label: "Rounded", value: 12 }] },
        align: { type: "radio", options: [{ label: "Left", value: "flex-start" }, { label: "Center", value: "center" }, { label: "Right", value: "flex-end" }] },
      },
      defaultProps: { label: "Do the thing", bg: "#5c4634", color: "#f6efe6", shape: 999, align: "flex-start" },
      render: ({ label, bg, color, shape, align }) => (
        <div style={{ display: "flex", justifyContent: align, padding: "12px 48px" }}>
          <span style={{ background: bg, color, borderRadius: Number(shape), padding: "12px 28px", fontWeight: 700 }}>{label}</span>
        </div>
      ),
    },
    Ground: {
      label: "Colored ground (holds blocks)",
      fields: { bg: colorField("Background"), padding: { type: "number", label: "Padding (px)" } },
      defaultProps: { bg: "#4a3729", padding: 24 },
      render: ({ bg, padding }) => (
        <div style={{ background: bg, padding }}>
          <DropZone zone="inside" />
        </div>
      ),
    },
    Spacer: {
      label: "Spacer",
      fields: { height: { type: "number", label: "Height (px)" } },
      defaultProps: { height: 40 },
      render: ({ height }) => <div style={{ height }} />,
    },
  },
  root: {
    fields: { bg: colorField("Page background") },
    defaultProps: { bg: "#f8f7f5" },
    render: (props: any) => (
      <div style={{ background: props.bg, minHeight: "60vh", fontFamily: "Inter, system-ui, sans-serif" }}>
        {props.children}
      </div>
    ),
  },
};

// The default arrangement: the site as it ships, so the editor opens as a
// preview of the website rather than an empty canvas.
const seeded = (type: string, id: string) => ({
  type,
  // Full defaults, not just an id: preloaded blocks must carry their props so
  // the field panel shows the current values instead of empty inputs.
  props: { id, ...(config.components as any)[type].defaultProps },
});
const DEFAULT_DATA: Data = {
  root: { props: { bg: "#f8f7f5" } },
  content: [
    seeded("LandingHero", "hero-1"),
    seeded("StageComposer", "stage-1"),
    seeded("StatBand", "stats-1"),
    seeded("FindCard", "card-1"),
  ],
} as Data;

const STORE_KEY = "scout_admin_page_design";

export default function PageEditor({ fill = false }: { fill?: boolean }) {
  const initial = useMemo<Data>(() => {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (raw) return JSON.parse(raw);
    } catch {}
    return DEFAULT_DATA;
  }, []);
  const [saved, setSaved] = useState(false);

  return (
    <div
      className={fill ? "h-full bg-surface" : "rounded-2xl border border-warm-border bg-surface p-2"}
      style={fill ? undefined : { height: "78vh" }}
    >
      <Puck
        config={config}
        data={initial}
        onPublish={(data: Data) => {
          try {
            localStorage.setItem(STORE_KEY, JSON.stringify(data));
          } catch {}
          try {
            navigator.clipboard.writeText(JSON.stringify(data, null, 1));
          } catch {}
          setSaved(true);
          setTimeout(() => setSaved(false), 2000);
        }}
      />
      {saved && (
        <p className="px-3 py-2 text-xs font-semibold text-sage-deep">
          Saved on this device and copied as JSON for engineering.
        </p>
      )}
    </div>
  );
}
