# dotgen

[![CI](https://github.com/davidjortizrivera/dotgen/actions/workflows/ci.yml/badge.svg)](https://github.com/davidjortizrivera/dotgen/actions/workflows/ci.yml)
![node](https://img.shields.io/badge/node-%E2%89%A522.18-brightgreen?logo=nodedotjs&logoColor=white)
[![npm](https://img.shields.io/npm/v/@davidjortizrivera/dotgen)](https://www.npmjs.com/package/@davidjortizrivera/dotgen)
![license](https://img.shields.io/badge/license-MIT-blue)

I work on a handful of projects at once, and every one of them has its own pile of `.env` files. Most of the values are the same everywhere (the dev database server, the same URLs), so I kept copying them around, and every time something changed I had to remember every repo that had a copy.

dotgen fixes that for me. I keep a single config file on my machine, and dotgen writes each project's `.env` files from it, along with TypeScript types that always match.

```sh
cd ~/Projects/myapp
dotgen development
```

For each part of the project (`apps/backend`, `apps/frontend`, …) that gives you:

- `.env.development` with the values (gitignored, only readable by you)
- `env.d.ts` with the types, which you commit
- optionally `env.ts`, so you can write `env.database.port` and get a real number back instead of a string

Your projects don't depend on dotgen at all. Bun and Vite keep reading their `.env` files like they always did, so if you stop using it, nothing breaks.

## Why I built it

A few things kept biting me:

- **Ports.** Every new Vite project wants port `5173`. When two are running, Vite quietly picks another port, and then the OAuth redirect stops working and I spend ten minutes figuring out why. dotgen gives each project its own ports and complains if two projects ever collide.
- **A password that lost characters.** Bun expands `$` inside `.env` values, even inside double quotes. I had a 12-character database password with a `$` in it, and the app was getting 8 characters. All I saw was "Login failed". dotgen escapes values the way each loader (Bun, Vite, Node) expects, and refuses values it can't write safely instead of silently mangling them.
- **Types that drift.** I was keeping `vite-env.d.ts` up to date by hand and it was never quite right. Now the types come from the same place as the values.

## What it does

- **Ports:** give a project a seed and it gets its ports from it (backend = seed + 1, frontend = seed + 2). `dotgen ports` shows the whole table.
- **Shared values:** put common values in `shared` once; projects can override them, and a `derive` function can build values like URLs from the ports.
- **Import what you already have:** `dotgen import` reads your existing `.env` files into the config. It only touches the lines it needs, so your comments and formatting stay put.
- **Spot duplicates:** `dotgen share` finds values repeated across projects and offers to move them into `shared`.
- **Secrets stay out of your terminal:** anything that looks like a password, secret, token, or key is shown only by its length (`set (12 chars)`), which is still enough to notice a truncated value.
- **Careful writes:** it won't overwrite a `.env` file it didn't create unless you pass `--force`, and it warns you if a generated file isn't gitignored.

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
