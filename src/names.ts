import { DotgenError } from "./errors.ts"
import type { Entry, Tree } from "./types.ts"

const upperKey = /^[A-Z][A-Z0-9_]*$/
const validKey = /^[A-Za-z][A-Za-z0-9_]*$/

// One key: `baseURL` → `BASE_URL`, `clientId` → `CLIENT_ID`, `oauth2` → `OAUTH2`.
// Keys that are already uppercase (`NODE_ENV`) are left as-is.
export function toEnvWord(key: string): string {
	if (!validKey.test(key)) {
		throw new DotgenError(`Invalid key "${key}": only letters, digits, and "_", starting with a letter.`)
	}
	if (upperKey.test(key)) return key
	return key
		// lowercase letter or digit followed by uppercase: `clientId`, `http2Server`
		.replace(/([a-z0-9])([A-Z])/g, "$1_$2")
		// end of an acronym before a word: `URLPath` → `URL_Path`
		.replace(/([A-Z])([A-Z][a-z])/g, "$1_$2")
		.toUpperCase()
}

// Nested path → variable name: `["api", "baseURL"]` → `API_BASE_URL`.
export function toEnvName(path: string[]): string {
	return path.map(toEnvWord).join("_")
}

function describe(value: unknown): string {
	if (value === null) return "null"
	if (Array.isArray(value)) return "an array"
	return typeof value
}

// Flattens the tree into entries sorted by name. Fails on disallowed values
// and on two paths that produce the same name (`database.server` and `databaseServer`).
export function flatten(tree: Tree, prefix: string[] = []): Entry[] {
	const entries: Entry[] = []

	function walk(node: Record<string, unknown>, path: string[]) {
		for (const [key, value] of Object.entries(node)) {
			const next = [...path, key]
			if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
				entries.push({ path: next, name: toEnvName(next), value })
			} else if (typeof value === "object" && value !== null && !Array.isArray(value)) {
				walk(value as Record<string, unknown>, next)
			} else {
				throw new DotgenError(`${[...prefix, ...next].join(".")}: ${describe(value)} isn't allowed; only string, number, or boolean.`)
			}
		}
	}

	walk(tree, [])
	assertNoCollisions(entries, prefix)
	return entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}

function assertNoCollisions(entries: Entry[], prefix: string[]) {
	const seen = new Map<string, Entry>()
	for (const entry of entries) {
		const other = seen.get(entry.name)
		if (other) {
			const a = [...prefix, ...other.path].join(".")
			const b = [...prefix, ...entry.path].join(".")
			throw new DotgenError(`${a} and ${b} produce the same name ${entry.name}.`)
		}
		seen.set(entry.name, entry)
	}
}
