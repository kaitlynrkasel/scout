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
        ink: "#2c2722", // near-black, faintly warm — for headings
        body: "#5f584e", // neutral warm-gray body text
        muted: "#9c968b", // captions / placeholders

        // Brown is now a single restrained accent, not the whole mood.
        brown: "#7c5837", // primary action / active nav / accent
        "brown-deep": "#5d4026", // deeper brown for links / gradients
        "brown-tint": "#efeae0", // soft neutral tint for hovers / chips
        clay: "#c8b899", // muted fills / avatars
        coffee: "#2b2620", // deep neutral for dark CTA cards
        sage: "#8c9a76", // secondary accent (logo nod), used sparingly
        "sage-deep": "#5f6a47", // deeper sage for text on sage tint
        danger: "#a6674a", // muted terracotta, reserved for "denied"

        // Surfaces — crisp white cards on a light, near-neutral page.
        cream: "#f5f2ec", // page background (faint warm tint)
        surface: "#ffffff", // cards / sidebar (crisp white)
        "surface-2": "#fbfaf7", // raised / inner surfaces

        // Legacy names, remapped to the new palette
        coral: "#7c5837", // was orange-coral -> primary brown
        blush: "#5d4026", // was pink -> brown-deep
        accent: "#5d4026", // links / accents -> deep brown (contrast on white)
        "warm-bg": "#f2efe8", // soft neutral background / hover
        "warm-border": "#e8e3d9", // hairline border (light neutral)
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
