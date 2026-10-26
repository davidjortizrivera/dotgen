import { projectEnvs } from "./config.ts"
import { configObject, parseSource, SourceEditor } from "./edit.ts"
import { DotgenError } from "./errors.ts"
import { merge } from "./merge.ts"
import { projectPorts } from "./ports.ts"
import { flatten, toEnvName } from "./names.ts"
import { availableEnvs, resolveProject } from "./resolve.ts"
import type { Config, Project } from "./schema.ts"
import type { Scalar, ShareCandidate, Tree } from "./types.ts"

// The project's own values (without `shared` or `derive`) per environment and target.
function ownValues(project: Project, env: string): Record<string, Tree> {
	return projectEnvs(project).includes(env) ? (project[env] as Record<string, Tree>) : {}
}

// What belongs to the app itself and makes no sense to share: paths that start with the name of
// one of the project's targets or ports (`backend.port`), or values that contain one of its
// registered ports (`https://localhost:3791`).
export function isAppSpecific(project: Project, ports: Record<string, number>, path: string[], value: Scalar): boolean {
	const head = path[0]!
	if (head in project.targets || head in ports) return true
	for (const port of Object.values(ports)) {
		if (value === port || (typeof value === "string" && value.includes(`:${port}`))) return true
	}
	return false
}

function nest(path: string[], value: Scalar): Tree {
	const tree: Tree = {}
	let node = tree
	for (const key of path.slice(0, -1)) node = node[key] = {} as Tree
	node[path.at(-1)!] = value
	return tree
}

// Values repeated across projects (same path, same value, same environment) and own
// values that already equal the ones in `shared`.
export function findShareCandidates(config: Config): ShareCandidate[] {
	const skip = new Set([...(config.unique ?? []), ...(config.local ?? [])])
	const projects = Object.entries(config.projects)
	const envs = [...new Set(projects.flatMap(([, project]) => projectEnvs(project)))].sort()
	const candidates: ShareCandidate[] = []

	for (const env of envs) {
		// `<target>\0<path>` → who has which value.
		const groups = new Map<string, { target: string; path: string[]; values: Array<{ project: string; value: Scalar }> }>()
		for (const [name, project] of projects) {
			for (const [target, tree] of Object.entries(ownValues(project, env))) {
				for (const entry of flatten(tree, [target])) {
					const key = `${target}\0${entry.path.join(".")}`
					const group = groups.get(key) ?? { target, path: entry.path, values: [] }
					group.values.push({ project: name, value: entry.value })
					groups.set(key, group)
				}
			}
		}

		for (const { target, path, values } of groups.values()) {
			const field = `${target}.${path.join(".")}`
			if (skip.has(field)) continue
			const sharedValue = flatten(config.shared?.[env]?.[target] ?? {}, [target]).find((entry) => entry.path.join(".") === path.join("."))?.value

			let value: Scalar
			let redundant = false
			if (sharedValue !== undefined) {
				// Already in shared: only the projects that repeat the same value are offered.
				value = sharedValue
				redundant = true
			} else {
				const counts = new Map<string, number>()
				for (const item of values) counts.set(String(item.value), (counts.get(String(item.value)) ?? 0) + 1)
				const [text, count] = [...counts].sort((a, b) => b[1] - a[1])[0]!
				if (count < 2) continue
				value = values.find((item) => String(item.value) === text)!.value
			}

			const same = values.filter((item) => String(item.value) === String(value)).map((item) => item.project)
			if (same.length === 0) continue
			if (!redundant && same.some((name) => isAppSpecific(config.projects[name]!, projectPorts(config, name, config.projects[name]!), path, value))) continue

			const holders = new Set(values.map((item) => item.project))
			const overrides = values.filter((item) => String(item.value) !== String(value)).map((item) => item.project)
			const receivers = redundant
				? []
				: projects.filter(([name, project]) => target in project.targets && !holders.has(name)).map(([name]) => name)
			candidates.push({ id: `${env}:${field}`, env, target, path, field, name: toEnvName(path), value, projects: same, receivers, overrides, redundant })
		}
	}
	return candidates.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

// New contents of `config.ts`: the chosen values move to `shared` and leave their projects;
// the ones marked `local` are added to `local`.
export function planShare(source: string, chosen: ShareCandidate[], local: string[]): string {
	const editor = new SourceEditor(source)
	const root = configObject(parseSource(source))

	let shared: Tree = {}
	for (const candidate of chosen) {
		if (!candidate.redundant) shared = merge(shared, { [candidate.env]: { [candidate.target]: nest(candidate.path, candidate.value) } })
	}
	if (Object.keys(shared).length > 0) editor.merge(root, { shared }, [])

	const paths = chosen.flatMap((candidate) => candidate.projects.map((project) => ["projects", project, candidate.env, candidate.target, ...candidate.path]))
	// `projects` and `projects.<name>` are never removed, even if they end up empty.
	editor.remove(root, paths, 2)
	editor.appendStrings(root, "local", local)
	return editor.apply()
}

function resolvedByProject(config: Config): Map<string, Scalar> {
	const values = new Map<string, Scalar>()
	for (const [name, project] of Object.entries(config.projects)) {
		for (const env of availableEnvs(config, project)) {
			for (const [target, tree] of Object.entries(resolveProject(config, name, env))) {
				for (const entry of flatten(tree, [target])) values.set(`${name}\0${env}\0${target}\0${entry.name}`, entry.value)
			}
		}
	}
	return values
}

// After moving to `shared`, every project must receive exactly what it did before;
// the only new values allowed are what the accepted `receivers` start receiving.
export function assertSameValues(before: Config, after: Config, chosen: ShareCandidate[]) {
	const previous = resolvedByProject(before)
	const next = resolvedByProject(after)
	const allowed = new Set(
		chosen.flatMap((candidate) => candidate.receivers.map((project) => `${project}\0${candidate.env}\0${candidate.target}\0${candidate.name}`))
	)
	const label = (key: string) => key.split("\0").join(" / ")
	for (const [key, value] of previous) {
		if (!next.has(key)) throw new DotgenError(`${label(key)} no longer exists.`)
		if (String(next.get(key)) !== String(value)) throw new DotgenError(`${label(key)} changed value.`)
	}
	for (const key of next.keys()) {
		const [project, env] = key.split("\0")
		// A new environment for a project (because it now exists in `shared`) doesn't count.
		if (!previous.has(key) && !allowed.has(key) && availableEnvs(before, before.projects[project!]!).includes(env!)) {
			throw new DotgenError(`${label(key)} appeared without being approved.`)
		}
	}
}
