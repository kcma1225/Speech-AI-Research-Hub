import adapter from "@sveltejs/adapter-static";
import { sveltekit } from "@sveltejs/kit/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    tailwindcss(),
    // SPA: nginx serves index.html for every non-asset path.
    sveltekit({ adapter: adapter({ fallback: "index.html", strict: false }) }),
  ],
  server: {
    // `npm run dev` proxies the API to a locally running backend.
    proxy: { "/api": { target: process.env.API_PROXY ?? "http://127.0.0.1:3000", changeOrigin: false } },
  },
});
