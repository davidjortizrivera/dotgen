import { describe, expect, it } from "vitest"
import { parseConfig } from "../src/config.ts"
import { assertNoConflicts, portConflicts, uniqueConflicts } from "../src/conflicts.ts"
import { defineConfig } from "../src/index.ts"

const targets = {
	backend: { dir: "apps/backend", loader: "bun" as const },
	frontend: { dir: "apps/frontend", loader: "vite" as const }
}

describe("portConflicts", () => {
	it("reports nothing without collisions", () => {
		const config = parseConfig(
			defineConfig({
				projects: {
					a: { path: "/a", targets, ports: { backend: 3001, frontend: 5001 } },
					b: { path: "/b", targets, ports: { backend: 3002, frontend: 5002 } }
				}
			})
		)
		expect(portConflicts(config)).toEqual([])
	})

	it("detects the same number across projects and roles", () => {
		const config = parseConfig(
			defineConfig({
				projects: {
					a: { path: "/a", targets, ports: { backend: 3001, frontend: 5001 } },
					b: { path: "/b", targets, ports: { backend: 5001 } }
				}
			})
		)
		expect(portConflicts(config)).toEqual(["Port 5001 repeated: projects.a.ports.frontend and projects.b.ports.backend."])
	})

	it("detects the same number within one project", () => {
		const config = parseConfig(defineConfig({ projects: { a: { path: "/a", targets, ports: { backend: 1, frontend: 1 } } } }))
		expect(portConflicts(config)).toHaveLength(1)
	})
})

describe("uniqueConflicts", () => {
	function config(bName: string | number) {
		return parseConfig(
			defineConfig({
				unique: ["backend.database.name", "frontend.vite.oauthRedirectUrl"],
				shared: { staging: { backend: { database: { server: "s" } } } },
				projects: {
					a: {
						path: "/a",
						targets,
						derive: () => ({ frontend: { vite: { oauthRedirectUrl: "https://localhost:5001/cb" } } }),
						development: { backend: { database: { name: "SAME" } } },
						production: { backend: { database: { name: "SAME" } } }
					},
					b: {
						path: "/b",
						targets,
						development: { backend: { database: { name: bName } } }
					}
				}
			})
		)
	}

	it("reports nothing without collisions", () => {
		expect(uniqueConflicts(config("OTHER"))).toEqual([])
	})

	it("detects the same value in the same environment, with both paths", () => {
		expect(uniqueConflicts(config("SAME"))).toEqual([
			'backend.database.name repeated in development ("SAME"): projects.a.development.backend.database.name and projects.b.development.backend.database.name.'
		])
	})

	it("compares as text, the way it reaches the .env", () => {
		const numeric = parseConfig(
			defineConfig({
				unique: ["backend.id"],
				projects: {
					a: { path: "/a", targets, development: { backend: { id: 7 } } },
					b: { path: "/b", targets, development: { backend: { id: "7" } } }
				}
			})
		)
		expect(uniqueConflicts(numeric)).toHaveLength(1)
	})

	it("includes values computed by derive", () => {
		const derived = parseConfig(
			defineConfig({
				unique: ["frontend.vite.url"],
				projects: {
					a: { path: "/a", targets, derive: () => ({ frontend: { vite: { url: "x" } } }), development: {} },
					b: { path: "/b", targets, derive: () => ({ frontend: { vite: { url: "x" } } }), development: {} }
				}
			})
		)
		expect(uniqueConflicts(derived)).toEqual([
			'frontend.vite.url repeated in development ("x"): projects.a.development.frontend.vite.url and projects.b.development.frontend.vite.url.'
		])
	})

	it("assertNoConflicts throws with every problem", () => {
		expect(() => assertNoConflicts(config("SAME"))).toThrow(/backend\.database\.name repeated/)
	})
})
