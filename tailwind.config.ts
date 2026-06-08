import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/app/**/*.{ts,tsx}",
    "./src/components/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        // semantic colors for the hub queue lanes / decision banners
        submit: "#16a34a",
        hold: "#d97706",
        failed: "#dc2626",
      },
    },
  },
  plugins: [],
};

export default config;
