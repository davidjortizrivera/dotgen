import { existsSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { configDir, configPath } from "./config.ts"
import { DotgenError } from "./errors.ts"
import { tildePath } from "./write.ts"

// Root of the installed package (works the same from `src/` and from `dist/`).
export const packageRoot = fileURLToPath(new URL("..", import.meta.url))

export function packageName(): string {
	return (JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as { name: string }).name
}

// No live data: an example `shared` would mix with real projects
// (`import` would skip values "already covered" by fake data). The example is commented out.
export function exampleConfig(name: string): string {
	return `import { defineConfig } from "${name}"

export default defineConfig({
	// Fields that can't repeat across projects (within the same environment),
	// e.g. "backend.database.name". Ports are always checked.
	unique: [],

	// Each target's port over the project's \`seed\`: seed + offset.
	portOffsets: { backend: 1, frontend: 2 },

	// What every project shares, per environment and target, e.g.:
	// development: { backend: { database: { server: "db-dev.example.com", port: 1433 } } }
	shared: {},

	// \`dotgen import <folder>\` adds projects here. A complete project looks like this:
	//
	// myapp: {
	// 	path: "~/Projects/myapp",
	// 	seed: 5010, // backend 5011, frontend 5012 (see portOffsets)
	// 	targets: {
	// 		backend: { dir: "apps/backend", loader: "bun" },
	// 		frontend: { dir: "apps/frontend", loader: "vite", accessor: true }
	// 	},
	// 	derive: (context) => {
	// 		const { port } = context
	// 		return {
	// 			backend: { backendPort: port.backend! },
	// 			frontend: { frontendPort: port.frontend!, vite: { backendBaseUrl: \`https://localhost:\${port.backend}\` } }
	// 		}
	// 	},
	// 	development: {
	// 		backend: { database: { name: "MYAPP", username: "myapp", password: "…" } }
	// 	}
	// }
	projects: {}
})
`
}

// Creates the example config and what's needed for \`import … from "<package>"\` to resolve.
export function initConfig(): string[] {
	const dir = configDir()
	const file = configPath()
	if (existsSync(file)) throw new DotgenError(`${tildePath(file)} already exists. Open it with \`dotgen edit\`.`)

	const name = packageName()
	const created: string[] = []
	mkdirSync(dir, { recursive: true, mode: 0o700 })

	writeFileSync(file, exampleConfig(name), { mode: 0o600 })
	created.push(file)

	const manifest = join(dir, "package.json")
	if (!existsSync(manifest)) {
		writeFileSync(manifest, `${JSON.stringify({ private: true, type: "module" }, null, "\t")}\n`)
		created.push(manifest)
	}

	// Link to the globally installed package, for types and the runtime import.
	const link = join(dir, "node_modules", name)
	if (!existsSync(link)) {
		mkdirSync(dirname(link), { recursive: true })
		symlinkSync(packageRoot, link, "dir")
		created.push(link)
	}
	return created
}

export function permissionWarning(file: string): string | undefined {
	if (!existsSync(file)) return undefined
	const mode = statSync(file).mode & 0o777
	if (mode === 0o600) return undefined
	return `${tildePath(file)} has permissions ${mode.toString(8)}; 600 is recommended (chmod 600 ${tildePath(file)}).`
}
