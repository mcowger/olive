import { join } from "node:path";
import homepage from "./src/index.html";

const generatedCss = "src/styles.generated.css";
const staticAssetNames = new Set([
  "apple-touch-icon.png",
  "favicon-128x128.png",
  "favicon-16x16.png",
  "favicon-32x32.png",
  "favicon-48x48.png",
  "favicon-64x64.png",
  "favicon.ico",
  "icon-192x192.png",
  "icon-512x512.png",
  "site.webmanifest"
]);
const tailwind = Bun.spawnSync([
  "bun",
  "run",
  "--cwd",
  "packages/web",
  "tailwindcss",
  "-c",
  "tailwind.config.js",
  "-i",
  "src/styles.css",
  "-o",
  generatedCss
], {
  stdout: "inherit",
  stderr: "inherit"
});

if (!tailwind.success) {
  process.exit(tailwind.exitCode ?? 1);
}

const tailwindWatch = Bun.spawn([
  "bun",
  "run",
  "--cwd",
  "packages/web",
  "tailwindcss",
  "-c",
  "tailwind.config.js",
  "-i",
  "src/styles.css",
  "-o",
  generatedCss,
  "--watch"
], {
  stdout: "inherit",
  stderr: "inherit"
});

const serverPort = process.env.OLIVE_BIND_PORT || process.env.PORT || process.env.PASEO_PORT || "4471";
const apiOrigin = process.env.OLIVE_API_ORIGIN || `http://127.0.0.1:${serverPort}`;

Bun.serve({
  development: {
    hmr: true,
    console: true
  },
  port: Number(process.env.OLIVE_WEB_PORT || 3000),
  routes: {
    "/": homepage
  },
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      const target = new URL(`${url.pathname}${url.search}`, apiOrigin);
      return fetch(new Request(target, request));
    }

    const assetName = url.pathname.slice(1);
    if (staticAssetNames.has(assetName)) {
      return new Response(Bun.file(join(import.meta.dir, "src", assetName)));
    }

    return homepage;
  }
});

function stopTailwind(): void {
  tailwindWatch.kill();
  process.exit(0);
}

process.on("SIGINT", stopTailwind);
process.on("SIGTERM", stopTailwind);
