# Olive

Olive is a local meeting archive. M0 provides the Bun monorepo scaffold, SQLite domain schema,
read-only meetings API, and React shell.

## Development

```sh
bun install
bun run build
bun run start
```

The server listens on `127.0.0.1:4471` by default. `bun run dev:web` starts Bun's native HTML-import
development server with HMR on port `3000` and proxies `/api/*` to the server.

Run checks with:

```sh
bun run typecheck
bun test
```

Runtime paths and bind settings are controlled by `OLIVE_CONFIG_DIR`, `OLIVE_MEETINGS_DIR`,
`OLIVE_BIND_HOST`, and `OLIVE_BIND_PORT`. Settings are stored in `settings.json` below the config
directory.

The meetings API contract is documented in [`docs/API.md`](docs/API.md).
