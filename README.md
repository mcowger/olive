# Olive

Olive is a local meeting archive. M0 provides the Bun monorepo scaffold, SQLite domain schema,
read-only meetings API, and React shell.

## Development

```sh
bun install
bun run build
bun run start
```

For live development with hot reload and file watching:

* `bun run dev`: Starts both the backend API server (with `--watch`) and the web client (with HMR & Tailwind watcher) concurrently.
* `bun run dev:server`: Starts only the backend API server on `127.0.0.1:4471` with `--watch`.
* `bun run dev:web`: Starts only the web development server on port `3000` with Bun's native HTML-import HMR, proxying `/api/*` to the backend.

Run checks with:

```sh
bun run typecheck
bun test
```

Runtime paths and bind settings are controlled by `OLIVE_CONFIG_DIR`, `OLIVE_MEETINGS_DIR`,
`OLIVE_BIND_HOST`, and `OLIVE_BIND_PORT`. Settings are stored in `settings.json` below the config
directory.

The meetings API contract is documented in [`docs/API.md`](docs/API.md).
