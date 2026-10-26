import { getProject, projectEnvs } from "./config.ts"
import { DotgenError } from "./errors.ts"
import { mergeTargets } from "./merge.ts"
import { projectPorts } from "./ports.ts"
import type { Config, Project } from "./schema.ts"
import type { Tree } from "./types.ts"

// Every environment that exists for a project: its own and those in `shared`.
export function availableEnvs(config: Config, project: Project): string[] {
	return [...new Set([...projectEnvs(project), ...Object.keys(config.shared ?? {})])].sort()
}

function projectLayer(project: Project, env: string): Record<string, Tree> | undefined {
	if (!projectEnvs(project).includes(env)) return undefined
	return project[env] as Record<string, Tree>
}

// Fails if one of the project's own layers uses a target that isn't in `targets`.
function assertTargets(name: string, project: Project, layer: Record<string, Tree> | undefined, source: string) {
	if (!layer) return
	for (const target of Object.keys(layer)) {
		if (!project.targets[target]) {
			const known = Object.keys(project.targets).join(", ") || "(none)"
			throw new DotgenError(`${source}: target "${target}" doesn't exist in projects.${name}.targets (${known}).`)
		}
	}
}

// Final values per target: `shared.<env>` → `derive(context)` → `projects.<p>.<env>`.
// Only includes the project's targets; anything `shared` defines for other targets is ignored.
export function resolveProject(config: Config, name: string, env: string): Record<string, Tree> {
	const project = getProject(config, name)
	const envs = availableEnvs(config, project)
	if (!envs.includes(env)) {
		throw new DotgenError(`Environment "${env}" doesn't exist for ${name}. Environments: ${envs.join(", ") || "(none)"}.`)
	}

	const shared = config.shared?.[env]
	const own = projectLayer(project, env)
	assertTargets(name, project, own, `projects.${name}.${env}`)

	const values = mergeTargets([shared, own])
	const derived = project.derive?.({ project: name, env, port: projectPorts(config, name, project), values: structuredClone(values) })
	assertTargets(name, project, derived, `projects.${name}.derive`)

	const merged = mergeTargets([shared, derived, own])
	const result: Record<string, Tree> = {}
	for (const target of Object.keys(project.targets)) {
		result[target] = merged[target] ?? {}
	}
	return result
}
