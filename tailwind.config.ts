import type { Config } from "tailwindcss";

// Warm-brown + cream design system (the "Scout" rebrand). Older token names
// (coral / blush / accent / warm-*) are kept but remapped to brown tones so the
// whole app shifts palette without touching every className; new tokens (brown /
// cream / surface / sage …) drive the sidebar + dashboard.
const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./lib/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: "#372c21", // espresso, for headings
        body: "#6e6155", // warm gray-brown body text
        muted: "#a2937f", // captions / placeholders

        // Brand browns
        brown: "#7a5b41", // primary action / active nav
        "brown-deep": "#5e4530", // deeper brown for links / gradients
        "brown-tint": "#efe4d4", // soft tint for hovers / chips
        sage: "#8c9a76", // secondary accent (logo nod), used sparingly
        danger: "#b08068", // muted terracotta, reserved for "denied"

        // Surfaces
        cream: "#f1eadf", // page background
        surface: "#fbf8f2", // cards / sidebar

        // Legacy names, remapped to the new palette
        coral: "#7a5b41", // was orange-coral -> primary brown
        blush: "#5e4530", // was pink -> brown-deep
        accent: "#5e4530", // links / accents -> deep brown (contrast on white)
        "warm-bg": "#efe6d6", // soft warm background / hover
        "warm-border": "#e7dccb", // warm hairline border
      },
      boxShadow: {
        soft: "0 1px 2px rgba(74, 54, 34, 0.05), 0 10px 26px -8px rgba(74, 54, 34, 0.14)",
        card: "0 2px 10px -3px rgba(74, 54, 34, 0.10)",
      },
      backgroundImage: {
        "brand-gradient": "linear-gradient(120deg, #7a5b41 0%, #5e4530 100%)",
        "warm-fade": "linear-gradient(180deg, #f1eadf 0%, #fbf8f2 60%)",
      },
    },
  },
  plugins: [],
};
export default config;
