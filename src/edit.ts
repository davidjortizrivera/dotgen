import type { Node, ObjectExpression, ObjectProperty, Program } from "@oxc-project/types"
import { parseSync } from "oxc-parser"
import { DotgenError } from "./errors.ts"
import type { RemovalTree, Scalar, TextEdit, Tree } from "./types.ts"

// What the editor can write: config values and string lists (`unique`, `local`).
type Value = Scalar | Tree | string[]

// Surgical edits to `config.ts`: the AST only locates positions; new text is inserted with
// the file's indentation and everything else (comments, `derive`, formatting) stays the same.

const identifier = /^[A-Za-z_$][A-Za-z0-9_$]*$/

function unwrap(node: Node): Node {
	let current = node
	while (current.type === "TSAsExpression" || current.type === "TSSatisfiesExpression" || current.type === "TSNonNullExpression" || current.type === "ParenthesizedExpression") {
		current = current.expression
	}
	return current
}

function keyOf(property: Node): string | undefined {
	if (property.type !== "Property" || property.computed) return undefined
	const { key } = property
	if (key.type === "Identifier") return key.name
	if (key.type === "Literal" && typeof key.value === "string") return key.value
	return undefined
}

// In JS, the last occurrence of a repeated key wins.
export function findProperty(object: ObjectExpression, key: string): ObjectProperty | undefined {
	return object.properties.findLast((property): property is ObjectProperty => keyOf(property) === key)
}

// oxc doesn't throw on syntax errors: it returns them alongside the AST.
export function parseSource(source: string): Program {
	const result = parseSync("config.ts", source, { lang: "ts", sourceType: "module" })
	const error = result.errors[0]
	if (error) throw new DotgenError(`Couldn't parse the config: ${error.message}`)
	return result.program
}

// The object in `export default defineConfig({ … })`, `export default { … }`, or `export default config`.
export function configObject(program: Program): ObjectExpression {
	const body = program.body
	const exported = body.find((statement) => statement.type === "ExportDefaultDeclaration")
	if (!exported) throw new DotgenError("The config has no `export default`.")
	let node = unwrap(exported.declaration)
	if (node.type === "Identifier") {
		const name = node.name
		for (const statement of body) {
			if (statement.type !== "VariableDeclaration") continue
			const declarator = statement.declarations.find((item) => item.id.type === "Identifier" && item.id.name === name)
			if (declarator?.init) node = unwrap(declarator.init)
		}
	}
	if (node.type === "CallExpression" && node.arguments[0]) node = unwrap(node.arguments[0])
	if (node.type !== "ObjectExpression") throw new DotgenError("Couldn't find the config object literal in `export default`.")
	return node
}

export function renderKey(key: string): string {
	return identifier.test(key) ? key : JSON.stringify(key)
}

export function renderScalar(value: Scalar): string {
	return typeof value === "string" ? JSON.stringify(value) : String(value)
}

function renderArray(values: string[]): string {
	return `[${values.map((value) => JSON.stringify(value)).join(", ")}]`
}

export class SourceEditor {
	readonly edits: TextEdit[] = []
	readonly unit: string

	constructor(readonly source: string) {
		const match = /\n([ \t]+)\S/.exec(source)
		this.unit = match?.[1]?.startsWith("\t") ? "\t" : (match?.[1] ?? "\t")
	}

	private lineStart(offset: number): number {
		return this.source.lastIndexOf("\n", offset - 1) + 1
	}

	private indentAt(offset: number): string {
		return /^[ \t]*/.exec(this.source.slice(this.lineStart(offset)))![0]
	}

	private sameLine(a: number, b: number): boolean {
		return !this.source.slice(Math.min(a, b), Math.max(a, b)).includes("\n")
	}

	renderBlock(value: Value, indent: string): string {
		if (Array.isArray(value)) return renderArray(value)
		if (typeof value !== "object") return renderScalar(value)
		const keys = Object.keys(value)
		if (keys.length === 0) return "{}"
		const inner = indent + this.unit
		const lines = keys.map((key) => `${inner}${renderKey(key)}: ${this.renderBlock(value[key]!, inner)}`)
		return `{\n${lines.join(",\n")}\n${indent}}`
	}

	renderInline(value: Value): string {
		if (Array.isArray(value)) return renderArray(value)
		if (typeof value !== "object") return renderScalar(value)
		const keys = Object.keys(value)
		if (keys.length === 0) return "{}"
		return `{ ${keys.map((key) => `${renderKey(key)}: ${this.renderInline(value[key]!)}`).join(", ")} }`
	}

	replace(node: Node, text: string) {
		this.edits.push({ start: node.start, end: node.end, text })
	}

	// Adds new keys at the end of the object, keeping it on one line or several as it was.
	insert(object: ObjectExpression, entries: Array<[string, Value]>) {
		if (entries.length === 0) return
		const { properties } = object
		const last = properties.at(-1)
		if (!last) {
			const closing = this.indentAt(object.start)
			const inner = closing + this.unit
			const lines = entries.map(([key, value]) => `${inner}${renderKey(key)}: ${this.renderBlock(value, inner)}`)
			this.replace(object, `{\n${lines.join(",\n")}\n${closing}}`)
			return
		}
		if (this.sameLine(object.start, properties[0]!.start)) {
			const text = entries.map(([key, value]) => `, ${renderKey(key)}: ${this.renderInline(value)}`).join("")
			this.edits.push({ start: last.end, end: last.end, text })
			return
		}
		const inner = this.indentAt(properties[0]!.start)
		const text = entries.map(([key, value]) => `,\n${inner}${renderKey(key)}: ${this.renderBlock(value, inner)}`).join("")
		this.edits.push({ start: last.end, end: last.end, text })
	}

	// Merges `tree` into the object: walks existing objects, replaces plain values,
	// and adds missing keys. `path` is only for error messages.
	merge(object: ObjectExpression, tree: Tree, path: string[]) {
		const missing: Array<[string, Scalar | Tree]> = []
		for (const [key, value] of Object.entries(tree)) {
			const property = findProperty(object, key)
			if (!property) {
				missing.push([key, value])
				continue
			}
			const here = [...path, key]
			const current = unwrap(property.value)
			if (typeof value === "object") {
				if (current.type !== "ObjectExpression") {
					throw new DotgenError(`${here.join(".")}: isn't an object literal in the config, so it can't be edited automatically.`)
				}
				this.merge(current, value, here)
			} else {
				if (current.type === "ObjectExpression") {
					throw new DotgenError(`${here.join(".")}: is an object in the config, but the imported value is a plain value.`)
				}
				this.replace(property.value, renderScalar(value))
			}
		}
		this.insert(object, missing)
	}

	// Adds strings to an array literal (`local: [...]`), creating it if needed.
	appendStrings(object: ObjectExpression, key: string, values: string[]) {
		if (values.length === 0) return
		const property = findProperty(object, key)
		if (!property) {
			this.insert(object, [[key, values]])
			return
		}
		const array = unwrap(property.value)
		if (array.type !== "ArrayExpression") throw new DotgenError(`${key}: isn't an array literal in the config, so it can't be edited automatically.`)
		const last = array.elements.findLast((element) => element !== null)
		if (!last) this.replace(array, renderArray(values))
		else this.edits.push({ start: last.end, end: last.end, text: values.map((value) => `, ${JSON.stringify(value)}`).join("") })
	}

	// Deletes the `paths` (relative to `object`). An object left empty is deleted too,
	// except those within the first `keep` levels (e.g. `projects.<name>`).
	remove(object: ObjectExpression, paths: string[][], keep = 0) {
		const tree: RemovalTree = {}
		for (const path of paths) {
			let node = tree
			for (const [index, key] of path.entries()) {
				if (node[key] === true) break
				if (index === path.length - 1) node[key] = true
				else node = (node[key] ??= {}) as RemovalTree
			}
		}
		this.edits.push(...this.removeIn(object, tree, 0, keep).edits)
	}

	private removeIn(object: ObjectExpression, tree: RemovalTree, depth: number, keep: number): { edits: TextEdit[]; empty: boolean } {
		const removed = new Set<ObjectProperty>()
		const edits: TextEdit[] = []
		for (const [key, rule] of Object.entries(tree)) {
			const property = findProperty(object, key)
			if (!property) continue
			if (rule === true) {
				removed.add(property)
				continue
			}
			const value = unwrap(property.value)
			if (value.type !== "ObjectExpression") continue
			const inner = this.removeIn(value, rule, depth + 1, keep)
			// If the child ended up empty and may be removed, delete the whole property (its edits are moot).
			if (inner.empty && depth >= keep) removed.add(property)
			else edits.push(...inner.edits)
		}
		if (removed.size === 0) return { edits, empty: false }
		const kept = object.properties.filter((property) => !removed.has(property as ObjectProperty))
		if (kept.length === 0) return { edits: [{ start: object.start, end: object.end, text: "{}" }], empty: true }
		return { edits: [...edits, ...this.cut(object, removed, kept)], empty: false }
	}

	// Removes properties from an object that keeps others. In multi-line objects it deletes
	// whole lines (comments on the others stay); otherwise it rebuilds the object.
	private cut(object: ObjectExpression, removed: Set<ObjectProperty>, kept: ObjectExpression["properties"]): TextEdit[] {
		const { properties } = object
		const rebuild = (): TextEdit[] => {
			const texts = kept.map((property) => this.source.slice(property.start, property.end))
			if (this.sameLine(object.start, properties[0]!.start)) return [{ start: object.start, end: object.end, text: `{ ${texts.join(", ")} }` }]
			const indent = this.indentAt(properties[0]!.start)
			const closing = this.indentAt(object.end - 1)
			return [{ start: object.start, end: object.end, text: `{\n${texts.map((text) => indent + text).join(",\n")}\n${closing}}` }]
		}

		const inline = this.sameLine(object.start, properties[0]!.start)
		const crowded = properties.some((property, index) => index > 0 && this.sameLine(properties[index - 1]!.end, property.start))
		if (inline || crowded) return rebuild()

		const edits: TextEdit[] = []
		for (const property of removed) {
			const lineEnd = this.source.indexOf("\n", property.end)
			const rest = this.source.slice(property.end, lineEnd === -1 ? undefined : lineEnd)
			// After the property there can only be a comma, whitespace, or a line comment.
			if (lineEnd === -1 || !/^\s*,?\s*(\/\/.*)?$/.test(rest)) return rebuild()
			edits.push({ start: this.lineStart(property.start), end: lineEnd + 1, text: "" })
		}

		// If the last one was deleted, the new last one must not gain a trailing comma it didn't have.
		const last = properties.at(-1) as ObjectProperty
		const lastKept = kept.at(-1)!
		if (removed.has(last) && !/^\s*,/.test(this.source.slice(last.end))) {
			const comma = /^\s*,/.exec(this.source.slice(lastKept.end))
			if (comma) {
				const position = lastKept.end + comma[0].length - 1
				edits.push({ start: position, end: position + 1, text: "" })
			}
		}
		return edits
	}

	// Applies edits back to front so pending positions don't shift.
	apply(): string {
		const edits = [...this.edits].sort((a, b) => b.start - a.start || b.end - a.end)
		let result = this.source
		let limit = Number.POSITIVE_INFINITY
		for (const edit of edits) {
			if (edit.end > limit) throw new Error("Overlapping edits in the config.")
			result = result.slice(0, edit.start) + edit.text + result.slice(edit.end)
			limit = edit.start
		}
		return result
	}
}
