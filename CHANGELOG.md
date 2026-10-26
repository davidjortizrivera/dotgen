# Changelog

## 0.1.1

- Rewrote the README.

## 0.1.0

First public release.

- `dotgen <env>`, `dotgen <project> <env>`, and `dotgen all <env>` generate `.env` files, `env.d.ts`, and an optional typed `env.ts` accessor from one global config.
- `dotgen check` validates the schema, names, unique fields, port collisions, paths, and stale typed files without writing.
- `dotgen ports` shows the port registry and sets seeds or explicit ports, refusing collisions.
- `dotgen import` reads existing `.env` files into the config, editing only the text it needs to.
- `dotgen share` moves values repeated across projects into `shared` and verifies no project's output changed unexpectedly.
- Loader-aware escaping for Bun, Vite, and Node, with secrets masked in all output.
