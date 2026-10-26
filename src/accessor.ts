import { isClientVar, tsHeader } from "./declarations.ts"
import { DotgenError } from "./errors.ts"
import type { Loader } from "./schema.ts"
import type { AccessorNode as Node, EnvVar, ScalarType } from "./types.ts"

const sources: Record<Loader, string> = {
	bun: "Bun.env",
	vite: "import.meta.env",
	node: "process.env"
}

// A path must have the same type in every environment.
function typeOf(item: EnvVar, prefix: string): ScalarType {
	const types = new Set(Object.values(item.types))
	if (types.size > 1) {
		const detail = Object.entries(item.types)
			.map(([env, type]) => `${type} in ${env}`)
			.join(", ")
		throw new DotgenError(`${prefix}.${item.path.join(".")}: has different types across environments (${detail}).`)
	}
	return [...types][0]!
}

function expression(item: EnvVar, source: string, type: ScalarType): string {
	const read = `${source}.${item.name}`
	if (type === "string") return item.required ? `${read}!` : read
	const converted = type === "number" ? `Number(${read})` : `${read} === "true"`
	return item.required ? converted : `${read} === undefined ? undefined : ${converted}`
}

function render(node: Node, depth: number): string {
	const indent = "\t".repeat(depth + 1)
	if (Object.keys(node).length === 0) return "{}"
	const lines = Object.entries(node).map(([key, value]) => `${indent}${key}: ${typeof value === "string" ? value : render(value, depth + 1)}`)
	return `{\n${lines.join(",\n")}\n${"\t".repeat(depth)}}`
}

// `env.ts`: rebuilds the nested object by reading from the environment, with the config's real types.
// `prefix` is only used in error messages (`projects.myapp.frontend`).
export function renderAccessor(context: { vars: EnvVar[]; loader: Loader; prefix: string }): string {
	const { vars, loader, prefix } = context
	const selected = loader === "vite" ? vars.filter(isClientVar) : vars
	const root: Node = {}
	const byPath = (item: EnvVar) => item.path.join(".")
	for (const item of [...selected].sort((a, b) => (byPath(a) < byPath(b) ? -1 : byPath(a) > byPath(b) ? 1 : 0))) {
		const type = typeOf(item, prefix)
		let node = root
		for (const key of item.path.slice(0, -1)) {
			node[key] ??= {}
			node = node[key] as Node
		}
		node[item.path.at(-1)!] = expression(item, sources[loader], type)
	}
	return `${tsHeader}. Do not edit.\nexport const env = ${render(root, 0)}\n`
}
