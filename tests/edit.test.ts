import { describe, expect, it } from "vitest"
import { configObject, parseSource, SourceEditor } from "../src/edit.ts"
import type { Tree } from "../src/types.ts"

function edit(source: string, tree: Tree): string {
	const editor = new SourceEditor(source)
	editor.merge(configObject(parseSource(source)), tree, [])
	return editor.apply()
}

const source = `import { defineConfig } from "dotgen"

export default defineConfig({
	// A comment that has to survive.
	projects: {
		myapp: {
			path: "~/Projects/myapp", // end of line
			targets: { backend: { dir: "apps/backend", loader: "bun" } },
			derive: (context) => ({ backend: { port: context.port.backend! } }),
			development: {
				backend: {
					database: { server: "db", port: 1433 },
					m3: {
						dryRun: true,
					},
				},
			},
		},
	},
})
`

describe("SourceEditor", () => {
	it("replaces values and adds keys without touching the rest", () => {
		const result = edit(source, {
			projects: {
				myapp: {
					development: {
						backend: { database: { port: 1434, name: "X" }, m3: { limit: 5 }, apiUrl: "https://a" }
					}
				}
			}
		})
		expect(result).toBe(
			source
				.replace("{ server: \"db\", port: 1433 }", '{ server: "db", port: 1434, name: "X" }')
				.replace("\t\t\t\t\t\tdryRun: true,", "\t\t\t\t\t\tdryRun: true,\n\t\t\t\t\t\tlimit: 5,")
				.replace("\t\t\t\t\t},\n\t\t\t\t},", '\t\t\t\t\t},\n\t\t\t\t\tapiUrl: "https://a",\n\t\t\t\t},')
		)
	})

	it("adds a new project with the file's indentation", () => {
		const result = edit(source, {
			projects: {
				wms: { path: "~/Projects/wms", targets: { backend: { dir: "apps/backend", loader: "bun" } }, development: { backend: { password: "a$b" } } }
			}
		})
		expect(result).toContain(
			[
				"\t\t},",
				"\t\twms: {",
				'\t\t\tpath: "~/Projects/wms",',
				"\t\t\ttargets: {",
				"\t\t\t\tbackend: {",
				'\t\t\t\t\tdir: "apps/backend",',
				'\t\t\t\t\tloader: "bun"',
				"\t\t\t\t}",
				"\t\t\t},",
				"\t\t\tdevelopment: {",
				"\t\t\t\tbackend: {",
				'\t\t\t\t\tpassword: "a$b"',
				"\t\t\t\t}",
				"\t\t\t}",
				"\t\t},",
				"\t},"
			].join("\n")
		)
		expect(result).toContain("// A comment that has to survive.")
		expect(result).toContain("derive: (context) => ({ backend: { port: context.port.backend! } }),")
	})

	it("fills empty objects", () => {
		const empty = "export default {\n\tprojects: {},\n}\n"
		expect(edit(empty, { projects: { a: { path: "/a" } } })).toBe('export default {\n\tprojects: {\n\t\ta: {\n\t\t\tpath: "/a"\n\t\t}\n\t},\n}\n')
	})

	it("respects space indentation", () => {
		const spaces = 'export default {\n  projects: {\n    a: { path: "/a" },\n  },\n}\n'
		expect(edit(spaces, { projects: { b: { path: "/b" } } })).toBe(
			'export default {\n  projects: {\n    a: { path: "/a" },\n    b: {\n      path: "/b"\n    },\n  },\n}\n'
		)
	})

	it("finds the config in `export default config` with satisfies", () => {
		const named = 'const config = { projects: {} } satisfies object\nexport default config\n'
		expect(edit(named, { projects: { a: { x: 1 } } })).toContain("a: {")
	})

	it("quotes keys that aren't identifiers", () => {
		expect(edit("export default { projects: {} }\n", { projects: { "my-app": { path: "/a" } } })).toContain('"my-app": {')
	})

	it("positions are JS string offsets even with accents and emoji before them", () => {
		const unicode = '// configuración ñ 🙂🙂\nexport default { projects: { a: { name: "José 🚀" } } }\n'
		expect(edit(unicode, { projects: { a: { name: "Ana", port: 1 } } })).toBe(
			'// configuración ñ 🙂🙂\nexport default { projects: { a: { name: "Ana", port: 1 } } }\n'
		)
	})

	it("fails on a syntax error", () => {
		expect(() => parseSource("export default {")).toThrow(/Couldn't parse the config/)
	})

	it("fails if the path isn't an object literal", () => {
		const shared = "const dev = {}\nexport default { projects: { a: { development: dev } } }\n"
		expect(() => edit(shared, { projects: { a: { development: { backend: { x: 1 } } } } })).toThrow(
			"projects.a.development: isn't an object literal"
		)
	})
})
