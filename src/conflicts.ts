import { DotgenError } from "./errors.ts"
import { portEntries } from "./ports.ts"
import { availableEnvs, resolveProject } from "./resolve.ts"
import type { Config } from "./schema.ts"
import type { Scalar, Tree } from "./types.ts"

// A port number repeated in any project (including one project's backend against another's frontend).
export function portConflicts(config: Config): string[] {
	const seen = new Map<number, string>()
	const problems: string[] = []
	for (const [name, project] of Object.entries(config.projects)) {
		for (const { port, source: here } of portEntries(config, name, project)) {
			if (port > 65535) {
				problems.push(`${here}: gives ${port}, out of range.`)
				continue
			}
			const other = seen.get(port)
			if (other) problems.push(`Port ${port} repeated: ${other} and ${here}.`)
			else seen.set(port, here)
		}
	}
	return problems
}

function valueAt(values: Record<string, Tree>, path: string[]): Scalar | undefined {
	let node: Scalar | Tree | undefined = values
	for (const key of path) {
		if (typeof node !== "object") return undefined
		node = node[key]
	}
	return typeof node === "object" ? undefined : node
}

// A `unique` field (`backend.database.name`) repeated across projects in the same environment.
export function uniqueConflicts(config: Config): string[] {
	const fields = config.unique ?? []
	if (fields.length === 0) return []

	const problems: string[] = []
	const envs = new Set(Object.values(config.projects).flatMap((project) => availableEnvs(config, project)))
	for (const env of [...envs].sort()) {
		const resolved: Array<[string, Record<string, Tree>]> = []
		for (const [name, project] of Object.entries(config.projects)) {
			if (availableEnvs(config, project).includes(env)) resolved.push([name, resolveProject(config, name, env)])
		}
		for (const field of fields) {
			const seen = new Map<string, string>()
			for (const [name, values] of resolved) {
				const value = valueAt(values, field.split("."))
				if (value === undefined) continue
				// Compared as text: 1433 and "1433" end up the same in the generated file.
				const key = String(value)
				const here = `projects.${name}.${env}.${field}`
				const other = seen.get(key)
				if (other) problems.push(`${field} repeated in ${env} (${JSON.stringify(key)}): ${other} and ${here}.`)
				else seen.set(key, here)
			}
		}
	}
	return problems
}

export function allConflicts(config: Config): string[] {
	return [...portConflicts(config), ...uniqueConflicts(config)]
}

export function assertNoConflicts(config: Config) {
	const problems = allConflicts(config)
	if (problems.length > 0) throw new DotgenError(problems.join("\n"))
}
