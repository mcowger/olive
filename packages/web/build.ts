import { rmSync } from "node:fs";

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
  const result = await Bun.build({
    entrypoints: ["packages/web/src/index.html"],
    outdir: "packages/web/dist",
    minify: true,
    target: "browser"
  });

  if (!result.success) {
    for (const log of result.logs) {
      console.error(log);
    }
    process.exitCode = 1;
  }
} catch (err) {
  console.error(err);
  process.exitCode = 1;
}
