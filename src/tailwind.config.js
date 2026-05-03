/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: "class",
  content: ["./*.html", "./js/**/*.js"],
  theme: {
    extend: {
      fontFamily: {
        sans: [
          "\"Plus Jakarta Sans\"",
          "\"PingFang SC\"",
          "\"Microsoft YaHei\"",
          "sans-serif"
        ],
        display: [
          "\"Space Grotesk\"",
          "\"Plus Jakarta Sans\"",
          "\"PingFang SC\"",
          "sans-serif"
        ],
        mono: ["\"IBM Plex Mono\"", "\"Cascadia Code\"", "monospace"]
      },
      colors: {
        aether: {
          blue: "#48aef2",
          violet: "#7b4ee8",
          cyan: "#8fe9f5",
          mint: "#bff7a6",
          ink: "#202330"
        }
      },
      boxShadow: {
        aura: "0 26px 90px rgba(91, 111, 226, 0.22)",
        soft: "0 18px 48px rgba(95, 111, 163, 0.16)",
        glow: "0 16px 34px rgba(80, 161, 244, 0.32)"
      },
      keyframes: {
        float: {
          "0%, 100%": { transform: "translateY(0)" },
          "50%": { transform: "translateY(-10px)" }
        },
        pulseDot: {
          "0%, 80%, 100%": { opacity: "0.35", transform: "scale(0.8)" },
          "40%": { opacity: "1", transform: "scale(1)" }
        },
        riseIn: {
          "0%": { opacity: "0", transform: "translateY(12px)" },
          "100%": { opacity: "1", transform: "translateY(0)" }
        }
      },
      animation: {
        float: "float 5s ease-in-out infinite",
        "pulse-dot": "pulseDot 1s ease-in-out infinite",
        "rise-in": "riseIn 420ms ease-out both"
      }
    }
  },
  plugins: []
};
