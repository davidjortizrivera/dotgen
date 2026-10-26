import { describe, expect, it, vi } from "vitest"
import { parseConfig } from "../src/config.ts"
import { defineConfig } from "../src/index.ts"
import { resolveProject } from "../src/resolve.ts"

function example() {
	return defineConfig({
		shared: {
			development: {
				backend: { database: { server: "db-dev", port: 1433 } },
				other: { ignored: true }
			},
			staging: { backend: { database: { server: "db-stg" } } }
		},
		projects: {
			myapp: {
				path: "/work/myapp",
				ports: { backend: 3791, frontend: 5791 },
				targets: {
					backend: { dir: "apps/backend", loader: "bun" },
					frontend: { dir: "apps/frontend", loader: "vite" }
				},
				derive: (context) => {
					const { port, values } = context
					return {
						backend: { backendPort: port.backend ?? 0, database: { name: `derived-${String((values.backend?.database as any)?.name)}` } },
						frontend: { vite: { backendBaseUrl: `https://localhost:${port.backend}` } }
					}
				},
				development: {
					backend: { database: { name: "MYAPP", password: "abc$defgh123" } }
				}
			}
		}
	})
}

describe("resolveProject", () => {
	it("merges shared → derive → project", () => {
		const result = resolveProject(parseConfig(example()), "myapp", "development")
		expect(result).toEqual({
			backend: {
				backendPort: 3791,
				database: { server: "db-dev", port: 1433, name: "MYAPP", password: "abc$defgh123" }
			},
			frontend: { vite: { backendBaseUrl: "https://localhost:3791" } }
		})
	})

	it("passes derive the merged shared + project values, without its own output", () => {
		const config = parseConfig(example())
		const derive = vi.fn(() => ({}))
		config.projects.myapp!.derive = derive
		resolveProject(config, "myapp", "development")
		expect(derive).toHaveBeenCalledWith({
			project: "myapp",
			env: "development",
			port: { backend: 3791, frontend: 5791 },
			values: {
				backend: { database: { server: "db-dev", port: 1433, name: "MYAPP", password: "abc$defgh123" } },
				other: { ignored: true }
			}
		})
	})

	it("derive can't mutate the config", () => {
		const config = parseConfig(example())
		config.projects.myapp!.derive = (context) => {
			;(context.values.backend!.database as any).name = "mutated"
			context.port.backend = 1
			return {}
		}
		expect(resolveProject(config, "myapp", "development").backend).toMatchObject({ database: { name: "MYAPP" } })
		expect(config.projects.myapp!.ports!.backend).toBe(3791)
	})

	it("accepts an environment that only exists in shared", () => {
		const result = resolveProject(parseConfig(example()), "myapp", "staging")
		expect(result.backend).toMatchObject({ database: { server: "db-stg", name: "derived-undefined" } })
	})

	it("always returns every target of the project", () => {
		const config = parseConfig(example())
		delete config.projects.myapp!.derive
		expect(Object.keys(resolveProject(config, "myapp", "staging"))).toEqual(["backend", "frontend"])
	})

	it("fails with an unknown environment", () => {
		expect(() => resolveProject(parseConfig(example()), "myapp", "prod")).toThrow(
			'Environment "prod" doesn\'t exist for myapp. Environments: development, staging.'
		)
	})

	it("fails with an unknown target in the environment or in derive", () => {
		const config = parseConfig(example())
		;(config.projects.myapp as any).development.web = { a: 1 }
		expect(() => resolveProject(config, "myapp", "development")).toThrow('projects.myapp.development: target "web" doesn\'t exist')

		const other = parseConfig(example())
		other.projects.myapp!.derive = () => ({ web: { a: 1 } })
		expect(() => resolveProject(other, "myapp", "development")).toThrow('projects.myapp.derive: target "web" doesn\'t exist')
	})
})
