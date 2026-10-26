# dotgen

[![CI](https://github.com/davidjortizrivera/dotgen/actions/workflows/ci.yml/badge.svg)](https://github.com/davidjortizrivera/dotgen/actions/workflows/ci.yml)
![node](https://img.shields.io/badge/node-%E2%89%A522.18-brightgreen?logo=nodedotjs&logoColor=white)
[![npm](https://img.shields.io/npm/v/@davidjortizrivera/dotgen)](https://www.npmjs.com/package/@davidjortizrivera/dotgen)
![license](https://img.shields.io/badge/license-MIT-blue)

**One typed config for every project's environment files.** dotgen reads a single TypeScript config that lives on your machine and generates each project's `.env` files, plus TypeScript declarations that always match them.

```sh
cd ~/Projects/myapp
dotgen development
```

For every target in the project (`apps/backend`, `apps/frontend`, …) this writes:

- `.env.development` with the values, gitignored and `chmod 600`
- `env.d.ts` with the variable types, meant to be committed
- `env.ts` (optional), a typed nested accessor that converts numbers and booleans back to their real types

Projects don't depend on dotgen at runtime. Bun and Vite keep loading their `.env` files the way they always have, so uninstalling dotgen breaks nothing.

## Why

- **Ports collide.** Every project starts on `5173`, and Vite silently moves to the next free port. That breaks OAuth redirect URIs and hard-coded URLs, and there's no single place that shows which project uses which port.
- **The same values are copied everywhere.** The same database server and URLs live in N repos, so changing one means editing N files.
- **Values get corrupted.** Bun expands `$` inside values, *even inside double quotes*. A 12-character password with a `$` in position 9 arrived with 8 characters, and the only symptom was "Login failed".
- **Types drift.** `vite-env.d.ts` and `ProcessEnv` are maintained by hand and never quite match the real `.env` files.

## Features

- **Port registry:** each project gets a port seed (backend = seed + 1, frontend = seed + 2). dotgen fails if any two projects share a port, so nothing shifts silently.
- **Loader-aware escaping:** values are escaped for the loader that will read them (Bun, Vite, or Node), based on an [escape matrix](scripts/escape-matrix.sh) tested against all three. Values no loader can read unambiguously are rejected instead of being silently mangled.
- **Layered values:** `shared` values per environment, computed values from a `derive` function (URLs built from ports, for example), and per-project overrides, deep-merged in that order.
- **Generated types:** `env.d.ts` is the union of every environment, so variables missing from some environments become optional, and CI can typecheck without any `.env` file.
- **`dotgen import`:** reads existing `.env` files and writes them into the config by editing only the necessary text. Your comments, formatting, and `derive` functions stay intact.
- **`dotgen share`:** finds values repeated across projects and moves the ones you pick into `shared`, then checks that no project's output changed unexpectedly.
- **Secrets stay hidden:** values whose names match `*PASSWORD*`, `*SECRET*`, `*TOKEN*`, or `*KEY*` are never printed, only their length (`set (12 chars)`), which is enough to spot a truncated value.
- **Safe writes:** dotgen won't overwrite a `.env` it didn't generate unless you pass `--force`, and it warns when a generated file isn't gitignored.

## Install

dotgen runs on Bun or on Node 22.18+, which runs `.ts` files natively.

```sh
npm install -g @davidjortizrivera/dotgen
# or
bun add -g @davidjortizrivera/dotgen
```

The command is `dotgen`.

## Usage

```sh
dotgen init                                    # create ~/.config/dotgen/config.ts
cd ~/Projects/myapp
dotgen import apps/backend/.env.development    # add the project, target, and values to the config
dotgen development                             # generate .env, env.d.ts, and env.ts
```

| Command | What it does |
|---|---|
| `dotgen init` | Creates an example config (`chmod 600`). |
| `dotgen edit` | Opens the config in `$EDITOR`. |
| `dotgen <env>` | Generates the project in the current folder. |
| `dotgen <project> <env>` | Generates that project. |
| `dotgen all <env>` | Generates that environment for every project. |
| `dotgen check` | Validates everything without writing: schema, names, conflicts, paths, and stale `env.d.ts` files. |
| `dotgen ports` | Shows the port table and flags collisions. |
| `dotgen ports <project> <seed>` | Sets a project's port seed, and fails without writing if it collides. |
| `dotgen share` | Moves values repeated across projects into `shared`. |
| `dotgen import <file \| folder> [env]` | Imports existing `.env` files into the config. |

Flags: `--dry-run` shows what would be written, `--force` allows overwriting files dotgen didn't generate, and `-v` shows values (secrets only by length).

## Config

```ts
import { defineConfig } from "@davidjortizrivera/dotgen"

export default defineConfig({
	// Fields that can't repeat across projects within an environment. Ports are always checked.
	unique: ["backend.database.name"],

	// Values every project receives, per environment and target.
	shared: {
		development: { backend: { database: { server: "db-dev.example.com", port: 1433 } } }
	},

	projects: {
		myapp: {
			path: "~/Projects/myapp",
			seed: 5010, // backend 5011, frontend 5012
			targets: {
				backend: { dir: "apps/backend", loader: "bun" },
				frontend: { dir: "apps/frontend", loader: "vite", accessor: true }
			},
			derive: (context) => {
				const { port } = context
				return {
					frontend: { vite: { backendBaseUrl: `https://localhost:${port.backend}` } }
				}
			},
			development: {
				backend: { database: { name: "MYAPP", username: "myapp", password: "abc$defgh123" } }
			}
		}
	}
})
```

Nested keys become uppercase variable names: `database.server` → `DATABASE_SERVER`, `m3.dryRun` → `M3_DRY_RUN`, `api.baseURL` → `API_BASE_URL`. In a Vite target, anything under `vite` gets the `VITE_` prefix and is exposed to the browser.

For the backend target above, `dotgen development` writes:

```sh
# Generated by dotgen from ~/.config/dotgen/config.ts (myapp / development).
DATABASE_NAME="MYAPP"
DATABASE_PASSWORD="abc\$defgh123"
DATABASE_PORT="1433"
DATABASE_SERVER="db-dev.example.com"
DATABASE_USERNAME="myapp"
```

The `$` is escaped because Bun would otherwise expand it. For a Node target it would be written as-is, since `node --env-file` doesn't expand variables.

## Development

```sh
bun install
bun run typecheck
bun run test        # Vitest
bun run build
```

The config is validated with [Zod](https://zod.dev), and `defineConfig`'s types are inferred from the same schema. `dotgen import` and `dotgen share` edit the config through [oxc-parser](https://oxc.rs) AST positions, so they change only the text they need to.

## License

MIT
