import { DotgenError } from "./errors.ts"
import type { Tree } from "./types.ts"

function isTree(value: unknown): value is Tree {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

// Deep merge: objects are combined, scalar values are overwritten (`over` wins).
// A scalar against an object at the same path is an error. Doesn't mutate its inputs.
export function merge(base: Tree, over: Tree, path: string[] = []): Tree {
	const result: Tree = { ...base }
	for (const [key, value] of Object.entries(over)) {
		const current = result[key]
		const here = [...path, key]
		if (current === undefined) {
			result[key] = isTree(value) ? merge({}, value, here) : value
		} else if (isTree(current) && isTree(value)) {
			result[key] = merge(current, value, here)
		} else if (isTree(current) !== isTree(value)) {
			throw new DotgenError(`${here.join(".")}: a scalar value collides with an object when merging layers.`)
		} else {
			result[key] = value
		}
	}
	return result
}

// Merges per-target layers (`{ backend: Tree, frontend: Tree }`), in increasing order of priority.
export function mergeTargets(layers: Array<Record<string, Tree> | undefined>): Record<string, Tree> {
	let result: Record<string, Tree> = {}
	for (const layer of layers) {
		if (!layer) continue
		result = merge(result, layer) as Record<string, Tree>
	}
	return result
}
