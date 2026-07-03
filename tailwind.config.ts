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
        serif: ["var(--font-serif)", "ui-serif", "Georgia", "serif"],
      },
      colors: {
        ink: "#3b2c1d", // espresso, for headings
        body: "#71624f", // warm taupe body text
        muted: "#a99a83", // captions / placeholders

        // Brand browns
        brown: "#7c5837", // primary action / active nav
        "brown-deep": "#5d4026", // deeper brown for links / gradients
        "brown-tint": "#ede2ce", // soft tint for hovers / chips
        clay: "#c8b899", // muted fills / avatars
        coffee: "#31241a", // deep coffee for dark CTA cards
        sage: "#8c9a76", // secondary accent (logo nod), used sparingly
        "sage-deep": "#5f6a47", // deeper sage for text on sage tint
        danger: "#a6674a", // muted terracotta, reserved for "denied"

        // Surfaces
        cream: "#f3ecdd", // page background
        surface: "#fffdf8", // cards / sidebar (bright warm ivory)
        "surface-2": "#fffffb", // raised / inner surfaces

        // Legacy names, remapped to the new palette
        coral: "#7c5837", // was orange-coral -> primary brown
        blush: "#5d4026", // was pink -> brown-deep
        accent: "#5d4026", // links / accents -> deep brown (contrast on white)
        "warm-bg": "#ede2ce", // soft warm background / hover
        "warm-border": "#e8dcc6", // warm hairline border
      },
      borderRadius: {
        // Slightly rounder across the app (bumped one notch from Tailwind defaults).
        lg: "0.7rem",
        xl: "1rem",
        "2xl": "1.35rem",
        "3xl": "1.75rem",
      },
      boxShadow: {
        soft: "0 1px 2px rgba(60, 42, 24, 0.04), 0 16px 34px -18px rgba(60, 42, 24, 0.16)",
        // Stacked-paper depth (notebook motif): a thin tan bottom edge + soft drop.
        card: "0 2px 0 #ddcfb4, 0 16px 28px -20px rgba(60, 42, 24, 0.28)",
      },
      backgroundImage: {
        "brand-gradient": "linear-gradient(120deg, #7c5837 0%, #684a2d 100%)",
        "warm-fade": "linear-gradient(180deg, #f3ecdd 0%, #fffdf8 60%)",
      },
    },
  },
  plugins: [],
};
export default config;
