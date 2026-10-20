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
    // API_PROXY may point at the compose nginx (e.g. http://127.0.0.1:18080); API_ORIGIN then rewrites the
    // Origin header to the stack's APP_ORIGIN so its CSRF check accepts writes from the dev server.
    proxy: {
      "/api": {
        target: process.env.API_PROXY ?? "http://127.0.0.1:3000",
        changeOrigin: false,
        configure: proxy => {
          const origin = process.env.API_ORIGIN;
          // Sandboxed deck iframes send `Origin: null` (opaque); leave those alone.
          if (origin) proxy.on("proxyReq", req => { const o = req.getHeader("origin"); if (o && o !== "null") req.setHeader("origin", origin); });
        },
      },
    },
  },
});
