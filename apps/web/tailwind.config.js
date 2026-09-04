/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      // Tap targets sized for a phone held one-handed while a toddler pulls on your arm.
      minHeight: { tap: "44px" },
    },
  },
  plugins: [],
};
