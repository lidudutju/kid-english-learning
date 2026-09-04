/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      // DESIGN.md (Miro) tokens. White canvas, hairline borders, black-pill CTAs; the canary
      // yellow is reserved for brand moments (the Today card, due markers, the preview bar).
      colors: {
        canvas: "#ffffff",
        surface: {
          DEFAULT: "#f7f8fa",
          soft: "#fafbfc",
          yellow: "#fff8e0",
          featured: "#f5f3ff",
        },
        hairline: {
          DEFAULT: "#e0e2e8",
          soft: "#eef0f3",
          strong: "#c7cad5",
        },
        ink: { DEFAULT: "#1c1c1e", deep: "#050038" },
        charcoal: "#2c2c34",
        subtle: "#555a6a",
        faint: "#6b6f7e",
        stone: "#8e91a0",
        mist: "#a5a8b5",
        brand: {
          yellow: "#ffd02f",
          "yellow-deep": "#fcb900",
          blue: "#4262ff",
          "blue-pressed": "#2a41b6",
          coral: "#ff9999",
          teal: "#0fbcb0",
        },
        "yellow-dark": "#746019",
        coral: { light: "#ffc6c6", dark: "#600000" },
        teal: { light: "#c3faf5" },
        success: "#00b473",
      },
      borderRadius: {
        xl: "16px",
        "2xl": "20px",
        "3xl": "28px",
      },
      fontFamily: {
        sans: [
          "Roobert PRO",
          "Noto Sans",
          "-apple-system",
          "BlinkMacSystemFont",
          "PingFang SC",
          "sans-serif",
        ],
      },
      // Tap targets sized for a phone held one-handed while a toddler pulls on your arm.
      minHeight: { tap: "44px" },
    },
  },
  plugins: [],
};
