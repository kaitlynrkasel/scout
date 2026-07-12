import type { Config } from "tailwindcss";

// Warm-brown + cream design system (the "Scout" rebrand), with a dusty
// slate-blue secondary accent (blue / blue-deep / blue-tint / slate) drawn from
// the linen-and-denim palette. Older token names (coral / blush / accent /
// warm-*) are remapped to brown tones, and sage now aliases the dusty blue, so
// the whole app shifts palette without touching every className. New tokens
// (brown / cream / surface / clay …) drive the sidebar + dashboard. Warm browns
// and tans ground it; the blue is the cool counterpoint, no green pops.
const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./lib/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: ["var(--font-sans)", "ui-sans-serif", "system-ui", "sans-serif"],
        // Bricolage Grotesque display face, shared with the landing page.
        display: ["var(--font-display)", "var(--font-sans)", "system-ui", "sans-serif"],
      },
      colors: {
        // Every token references a CSS variable (space-separated RGB triplet)
        // defined in globals.css, so the whole palette flips for dark mode by
        // toggling a `.dark` class on <html>. Light values live on :root; dark
        // overrides on .dark. See globals.css for the actual values.
        ink: "rgb(var(--c-ink) / <alpha-value>)",
        body: "rgb(var(--c-body) / <alpha-value>)",
        muted: "rgb(var(--c-muted) / <alpha-value>)",

        brown: "rgb(var(--c-brown) / <alpha-value>)",
        "brown-deep": "rgb(var(--c-brown-deep) / <alpha-value>)",
        "brown-tint": "rgb(var(--c-brown-tint) / <alpha-value>)",
        clay: "rgb(var(--c-clay) / <alpha-value>)",
        coffee: "rgb(var(--c-coffee) / <alpha-value>)",

        success: "rgb(var(--c-success) / <alpha-value>)",
        "success-deep": "rgb(var(--c-success-deep) / <alpha-value>)",
        attention: "rgb(var(--c-attention) / <alpha-value>)",
        danger: "rgb(var(--c-danger) / <alpha-value>)",
        sage: "rgb(var(--c-sage) / <alpha-value>)",
        "sage-deep": "rgb(var(--c-sage-deep) / <alpha-value>)",
        // Dusty slate-blue secondary accent (pairs with the warm browns).
        blue: "rgb(var(--c-blue) / <alpha-value>)",
        "blue-deep": "rgb(var(--c-blue-deep) / <alpha-value>)",
        "blue-tint": "rgb(var(--c-blue-tint) / <alpha-value>)",
        slate: "rgb(var(--c-slate) / <alpha-value>)",

        cream: "rgb(var(--c-cream) / <alpha-value>)",
        surface: "rgb(var(--c-surface) / <alpha-value>)",
        "surface-2": "rgb(var(--c-surface-2) / <alpha-value>)",

        // Legacy names, remapped to the same variables.
        coral: "rgb(var(--c-brown) / <alpha-value>)",
        blush: "rgb(var(--c-brown-deep) / <alpha-value>)",
        accent: "rgb(var(--c-brown-deep) / <alpha-value>)",
        "warm-bg": "rgb(var(--c-warm-bg) / <alpha-value>)",
        "warm-border": "rgb(var(--c-warm-border) / <alpha-value>)",
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
        card: "0 1px 2px rgba(40, 30, 18, 0.04)",
        // Reserved for floating surfaces: the Ask Scout bar, command palette, peek.
        float:
          "0 14px 44px -16px rgba(40, 30, 18, 0.22), 0 2px 6px -2px rgba(40, 30, 18, 0.06)",
      },
      backgroundImage: {
        // Mystic Navy primary action (Pantone 7546C, #13273F). Navy leads
        // interaction across app + landing; dusty blue is the light accent, brown
        // + cream the warm identity.
        "brand-gradient": "linear-gradient(120deg, #1c3a5c 0%, #13273f 100%)",
        "warm-fade": "linear-gradient(180deg, #f5f2ec 0%, #ffffff 60%)",
      },
    },
  },
  plugins: [],
};
export default config;
