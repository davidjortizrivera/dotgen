import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { assertPaths, detectProject, getProject, loadConfig, parseConfig, projectEnvs } from "../src/config.ts"
import { defineConfig } from "../src/index.ts"

const example = defineConfig({
	unique: ["backend.database.name"],
	shared: {
		development: { backend: { database: { server: "db-dev", port: 1433 } } }
	},
	projects: {
		myapp: {
			path: "/work/myapp",
			ports: { backend: 3791, frontend: 5791 },
			targets: {
				backend: { dir: "apps/backend", loader: "bun" },
				frontend: { dir: "apps/frontend", loader: "vite", accessor: true }
			},
			derive: (context) => {
				const { port } = context
				return { backend: { backendPort: port.backend ?? 0 } }
			},
			development: { backend: { database: { name: "MYAPP" } } },
			production: { backend: { database: { name: "MYAPP" } } }
		},
		nested: {
			path: "/work/myapp/tools/nested",
			targets: { cli: { dir: ".", loader: "node" } }
		}
	}
})

describe("parseConfig", () => {
	it("accepts a valid config", () => {
		expect(parseConfig(example).projects.myapp?.path).toBe("/work/myapp")
	})

	it("shows the path of the failing field", () => {
		const broken = structuredClone({ ...example, projects: { myapp: { ...example.projects.myapp, derive: undefined } } }) as any
		broken.projects.myapp.targets.frontend.dir = 42
		expect(() => parseConfig(broken, "config.ts")).toThrow("projects.myapp.targets.frontend.dir:")
	})

	it("rejects unknown loaders, out-of-range ports, and extra keys", () => {
		const broken = {
			extra: true,
			projects: {
				a: { path: "/a", ports: { web: 70000 }, targets: { web: { dir: ".", loader: "deno" } } }
			}
		}
		let message = ""
		try {
			parseConfig(broken, "config.ts")
		} catch (error) {
			message = (error as Error).message
		}
		expect(message).toContain("projects.a.ports.web:")
		expect(message).toContain("projects.a.targets.web.loader:")
		expect(message).toMatch(/extra/)
	})

	it("rejects arrays and null in values", () => {
		const broken = {
			projects: {
				a: { path: "/a", targets: {}, development: { backend: { list: [1], empty: null } } }
			}
		}
		expect(() => parseConfig(broken, "config.ts")).toThrow(/projects\.a\.development\.backend\.list/)
	})

	it("rejects a derive that isn't a function", () => {
		const broken = { projects: { a: { path: "/a", targets: {}, derive: "x" } } }
		expect(() => parseConfig(broken, "config.ts")).toThrow("projects.a.derive: derive must be a function")
	})
})

describe("projects", () => {
	const config = parseConfig(example)

	it("lists environments without the reserved keys", () => {
		expect(projectEnvs(getProject(config, "myapp"))).toEqual(["development", "production"])
	})

	it("fails with an unknown project", () => {
		expect(() => getProject(config, "nope")).toThrow('Project "nope" doesn\'t exist. Projects: myapp, nested.')
	})

	it.each([
		["/work/myapp", "myapp"],
		["/work/myapp/apps/backend", "myapp"],
		["/work/myapp/tools/nested/src", "nested"]
	])("detects %s → %s", (cwd, name) => {
		expect(detectProject(config, cwd)).toBe(name)
	})

	it("doesn't confuse folder name prefixes", () => {
		expect(() => detectProject(config, "/work/myapp2")).toThrow(/isn't inside any project/)
	})
})

describe("files", () => {
	const root = mkdtempSync(join(tmpdir(), "dotgen-config-"))

	it("loads a config.ts with export default", async () => {
		const file = join(root, "config.ts")
		writeFileSync(file, `export default { projects: { a: { path: "/a", targets: {} } } }\n`)
		const config = await loadConfig(file)
		expect(Object.keys(config.projects)).toEqual(["a"])
	})

	it("fails if it doesn't exist", async () => {
		await expect(loadConfig(join(root, "missing.ts"))).rejects.toThrow(/dotgen init/)
	})

	it("fails without export default", async () => {
		const file = join(root, "no-default.ts")
		writeFileSync(file, "export const x = 1\n")
		await expect(loadConfig(file)).rejects.toThrow(/export default/)
	})

	it("validates path and dir", () => {
		mkdirSync(join(root, "app", "apps", "backend"), { recursive: true })
		const project = { path: join(root, "app"), targets: { backend: { dir: "apps/backend", loader: "bun" as const } } }
		expect(() => assertPaths("app", project)).not.toThrow()
		const missing = { ...project, targets: { web: { dir: "apps/web", loader: "vite" as const } } }
		expect(() => assertPaths("app", missing)).toThrow(/projects\.app\.targets\.web\.dir: .* doesn't exist/)
	})
})
