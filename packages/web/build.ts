import { cpSync, rmSync } from "node:fs";

export {};

const generatedCss = "packages/web/src/styles.generated.css";

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
  "src/styles.generated.css",
  "--minify"
], {
  stdout: "inherit",
  stderr: "inherit"
});

if (!tailwind.success) {
  process.exit(tailwind.exitCode ?? 1);
}

try {
  rmSync("packages/web/dist", { recursive: true, force: true });
  const buildOptions = {
    entrypoints: ["packages/web/src/index.html"],
    outdir: "packages/web/dist",
    publicPath: "/",
    minify: true,
    target: "browser",
    reactCompiler: true
  } as Parameters<typeof Bun.build>[0] & { reactCompiler: boolean };
  const result = await Bun.build(buildOptions);

  if (!result.success) {
    for (const log of result.logs) {
      console.error(log);
    }
    process.exitCode = 1;
  } else {
    for (const asset of [
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
    ]) {
      cpSync(`packages/web/src/${asset}`, `packages/web/dist/${asset}`);
    }
  }
} catch (err) {
  console.error(err);
  process.exitCode = 1;
}
