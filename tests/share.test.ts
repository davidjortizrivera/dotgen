import { describe, expect, it } from "vitest"
import { parseConfig } from "../src/config.ts"
import { configObject, parseSource, SourceEditor } from "../src/edit.ts"
import { defineConfig } from "../src/index.ts"
import { assertSameValues, findShareCandidates, isAppSpecific, planShare } from "../src/share.ts"

const targets = { backend: { dir: "apps/backend", loader: "bun" as const } }

function config() {
	return parseConfig(
		defineConfig({
			unique: ["backend.database.name"],
			local: ["backend.m3.username"],
			shared: { development: { backend: { database: { server: "db-dev" } } } },
			projects: {
				a: {
					path: "/a",
					targets,
					ports: { backend: 3001 },
					development: {
						backend: {
							resend: { token: "t" },
							database: { name: "A", server: "db-dev", port: 1433 },
							m3: { username: "u" },
							backend: { port: 3001 },
							frontend: { url: "https://localhost:3001" }
						}
					}
				},
				b: {
					path: "/b",
					targets,
					ports: { backend: 3002 },
					development: {
						backend: { resend: { token: "t" }, database: { name: "B", port: 1433 }, m3: { username: "u" }, backend: { port: 3001 } }
					}
				},
				c: { path: "/c", targets, development: { backend: { resend: { token: "other" } } } },
				d: { path: "/d", targets }
			}
		})
	)
}

describe("findShareCandidates", () => {
	it("suggests repeated and redundant values, skipping unique, local, and app-specific ones", () => {
		const candidates = findShareCandidates(config())
		expect(candidates.map((candidate) => candidate.id)).toEqual([
			"development:backend.database.port",
			"development:backend.database.server",
			"development:backend.resend.token"
		])
		const token = candidates.find((candidate) => candidate.field === "backend.resend.token")!
		expect(token).toMatchObject({ name: "RESEND_TOKEN", value: "t", projects: ["a", "b"], overrides: ["c"], receivers: ["d"], redundant: false })
		const server = candidates.find((candidate) => candidate.field === "backend.database.server")!
		expect(server).toMatchObject({ redundant: true, projects: ["a"], receivers: [] })
	})

	it("isAppSpecific: target or port name, or a value containing one of the project's ports", () => {
		const project = config().projects.a!
		expect(isAppSpecific(project, project.ports!, ["backend", "port"], 1)).toBe(true)
		expect(isAppSpecific(project, project.ports!, ["api", "url"], "https://localhost:3001/x")).toBe(true)
		expect(isAppSpecific(project, project.ports!, ["api", "port"], 3001)).toBe(true)
		expect(isAppSpecific(project, project.ports!, ["database", "port"], 1433)).toBe(false)
	})
})

describe("planShare", () => {
	const source = `export default {
	shared: {},
	projects: {
		a: {
			development: {
				backend: {
					resend: { token: "t" },
					database: { name: "A", port: 1433 }, // comment
					debug: true
				}
			}
		},
		b: {
			development: {
				backend: {
					resend: { token: "t" }
				}
			}
		}
	}
}
`
	const candidate = (field: string, path: string[], value: string | number, projects: string[]) => ({
		id: `development:${field}`,
		env: "development",
		target: "backend",
		path,
		field,
		name: "",
		value,
		projects,
		receivers: [],
		overrides: [],
		redundant: false
	})

	it("moves to shared, deletes from projects, and cleans up what's left empty", () => {
		const result = planShare(source, [candidate("backend.resend.token", ["resend", "token"], "t", ["a", "b"])], ["backend.debug"])
		expect(result).toBe(`export default {
	shared: {
		development: {
			backend: {
				resend: {
					token: "t"
				}
			}
		}
	},
	projects: {
		a: {
			development: {
				backend: {
					database: { name: "A", port: 1433 }, // comment
					debug: true
				}
			}
		},
		b: {}
	},
	local: ["backend.debug"]
}
`)
	})

	it("deleting the last property doesn't leave a new trailing comma", () => {
		const result = planShare(source, [candidate("backend.debug", ["debug"], "true", ["a"])], [])
		expect(result).toContain('database: { name: "A", port: 1433 } // comment\n\t\t\t\t}')
	})

	it("rebuilds one-line objects from the original text", () => {
		const result = planShare(source, [candidate("backend.database.port", ["database", "port"], 1433, ["a"])], [])
		expect(result).toContain('database: { name: "A" }, // comment')
	})

	it("appends to an existing `local`", () => {
		const editor = new SourceEditor('export default { local: ["x"], projects: {} }\n')
		editor.appendStrings(configObject(parseSource(editor.source)), "local", ["y", "z"])
		expect(editor.apply()).toBe('export default { local: ["x", "y", "z"], projects: {} }\n')
	})
})

describe("assertSameValues", () => {
	it("accepts moving to shared when nothing changes", () => {
		const before = config()
		const after = config()
		after.shared = { development: { backend: { database: { server: "db-dev" }, resend: { token: "t" } } } }
		delete (after.projects.a as any).development.backend.resend
		delete (after.projects.b as any).development.backend.resend
		const chosen = findShareCandidates(before).filter((candidate) => candidate.field === "backend.resend.token")
		expect(() => assertSameValues(before, after, chosen)).not.toThrow()
	})

	it("fails if a project receives something that wasn't approved", () => {
		const before = config()
		const after = config()
		after.shared = { development: { backend: { database: { server: "db-dev" }, resend: { token: "t" } } } }
		expect(() => assertSameValues(before, after, [])).toThrow("d / development / backend / RESEND_TOKEN appeared without being approved.")
	})

	it("fails if a value changes", () => {
		const before = config()
		const after = config()
		;(after.projects.a as any).development.backend.resend.token = "x"
		expect(() => assertSameValues(before, after, [])).toThrow("a / development / backend / RESEND_TOKEN changed value.")
	})
})
