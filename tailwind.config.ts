import type { Config } from "tailwindcss";

// Warm-brown + cream design system (the "Scout" rebrand). Older token names
// (coral / blush / accent / warm-*) are kept but remapped to brown tones so the
// whole app shifts palette without touching every className; new tokens (brown /
// cream / surface / clay …) drive the sidebar + dashboard. The palette is warm
// but restrained — inviting browns over a bright cream, no orange/green pops.
const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./lib/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: ["var(--font-sans)", "ui-sans-serif", "system-ui", "sans-serif"],
      },
      colors: {
        ink: "#201d18", // near-black, faint warm — headings (AA+ on white)
        body: "#57534c", // body text (~8:1 on white)
        muted: "#7c776d", // secondary text (~5.3:1 on white, still AA)

        // Brown is the single restrained accent — primary action, selection, state.
        brown: "#7c5837", // primary action / active nav / accent
        "brown-deep": "#5d4026", // hover / pressed
        "brown-tint": "#f2ece1", // soft selection / positive tint
        clay: "#c8b899", // muted fills / avatars
        coffee: "#26221c", // deep neutral for the rare dark surface

        // Standardized semantic states.
        success: "#3f7a52", // replied / positive
        "success-deep": "#2f5c3f",
        attention: "#a9761f", // needs-attention / due
        danger: "#b0553f", // denied / error
        sage: "#8c9a76", // subtle live/connected dot (logo nod)
        "sage-deep": "#5f6a47",

        // Surfaces — white panels on a light near-neutral canvas; a distinct
        // off-white for the sidebar/inset layer.
        cream: "#f3f2ef", // page canvas (near-neutral, whisper of warmth)
        surface: "#ffffff", // panels / cards
        "surface-2": "#fbfbf9", // sidebar / inset layer

        // Legacy names, remapped.
        coral: "#7c5837",
        blush: "#5d4026",
        accent: "#5d4026",
        "warm-bg": "#f4f2ee", // hover fill
        "warm-border": "#e8e6e0", // hairline border
      },
      borderRadius: {
        // Tighter, more professional corners (crisper than Tailwind defaults).
        lg: "0.5rem", // 8px
        xl: "0.625rem", // 10px
        "2xl": "0.75rem", // 12px
        "3xl": "0.875rem", // 14px
      },
      boxShadow: {
        soft: "0 1px 2px rgba(40, 32, 24, 0.05), 0 10px 24px -14px rgba(40, 32, 24, 0.12)",
        // Minimal, flat elevation — separation comes from hairline borders.
        card: "0 1px 2px rgba(40, 32, 24, 0.05)",
      },
      backgroundImage: {
        "brand-gradient": "linear-gradient(120deg, #7c5837 0%, #684a2d 100%)",
        "warm-fade": "linear-gradient(180deg, #f5f2ec 0%, #ffffff 60%)",
      },
    },
  },
  plugins: [],
};
export default config;
