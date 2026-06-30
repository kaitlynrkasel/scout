import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./lib/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: "#2c2230", // warm near-black for headings
        body: "#6b5f66", // warm gray for body text
        coral: "#ff7a5c", // primary warm orange-coral
        blush: "#ff6f91", // pink end of the gradient
        accent: "#e8566b", // deeper coral for text/links (better contrast on white)
        "warm-bg": "#fff7f3", // soft warm section background
        "warm-border": "#f4e4dd", // warm hairline border
      },
      boxShadow: {
        soft: "0 6px 24px -8px rgba(232, 86, 107, 0.18)",
        card: "0 2px 10px -3px rgba(44, 34, 48, 0.08)",
      },
      backgroundImage: {
        "brand-gradient": "linear-gradient(100deg, #ff8a5b 0%, #ff6f91 100%)",
        "warm-fade": "linear-gradient(180deg, #fff7f3 0%, #ffffff 60%)",
      },
    },
  },
  plugins: [],
};
export default config;
