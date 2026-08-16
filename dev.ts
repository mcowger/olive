const publicPort = Number(process.env.PORT || process.env.PASEO_PORT || process.env.OLIVE_WEB_PORT || 3000);
const backendPort = publicPort === 4471 ? 4472 : Number(process.env.OLIVE_BIND_PORT || 4471);
const apiOrigin = process.env.OLIVE_API_ORIGIN || `http://127.0.0.1:${backendPort}`;

const serverProc = Bun.spawn(["bun", "--watch", "packages/server/src/index.ts"], {
  stdout: "inherit",
  stderr: "inherit",
  env: {
    ...process.env,
    OLIVE_BIND_PORT: String(backendPort)
  }
});

const webProc = Bun.spawn(["bun", "run", "packages/web/dev.ts"], {
  stdout: "inherit",
  stderr: "inherit",
  env: {
    ...process.env,
    OLIVE_WEB_PORT: String(publicPort),
    OLIVE_API_ORIGIN: apiOrigin
  }
});

function cleanup() {
  serverProc.kill();
  webProc.kill();
  process.exit(0);
}

process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);

await Promise.race([serverProc.exited, webProc.exited]);
cleanup();
