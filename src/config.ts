import { existsSync, realpathSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve, sep } from "node:path"
import { pathToFileURL } from "node:url"
import type { z } from "zod"
import { DotgenError } from "./errors.ts"
import { config as configSchema, reserved, type Config, type Project } from "./schema.ts"

export function configDir(): string {
	if (process.env.DOTGEN_CONFIG_DIR) return process.env.DOTGEN_CONFIG_DIR
	const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config")
	return join(base, "dotgen")
}

export function configPath(): string {
	return join(configDir(), "config.ts")
}

// Absolute path without symlinks (on macOS `/var` → `/private/var`), for comparing folders.
export function realPath(path: string): string {
	const absolute = resolve(expandHome(path))
	try {
		return realpathSync(absolute)
	} catch {
		return absolute
	}
}

export function expandHome(path: string): string {
	if (path === "~") return homedir()
	if (path.startsWith("~/")) return join(homedir(), path.slice(2))
	return path
}

function formatIssues(error: z.ZodError): string {
	return error.issues
		.map((issue) => {
			const path = issue.path.map(String).join(".")
			return path ? `  ${path}: ${issue.message}` : `  ${issue.message}`
		})
		.join("\n")
}

// Validates an already-loaded object. Separate from `loadConfig` so it can be tested without files.
export function parseConfig(value: unknown, file = configPath()): Config {
	const result = configSchema.safeParse(value)
	if (!result.success) {
		throw new DotgenError(`${file} doesn't match the schema:\n${formatIssues(result.error)}`)
	}
	return result.data
}

let loads = 0

export async function loadConfig(file = configPath()): Promise<Config> {
	if (!existsSync(file)) {
		throw new DotgenError(`${file} doesn't exist. Create it with \`dotgen init\`.`)
	}
	let module: { default?: unknown }
	try {
		// The query bypasses the module cache when loading more than once in the same process
		// (e.g. `import` reloads the freshly edited config, sometimes within the same millisecond).
		module = await import(`${pathToFileURL(file).href}?load=${++loads}`)
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error)
		throw new DotgenError(`Couldn't load ${file}:\n  ${reason}`)
	}
	if (module.default === undefined) {
		throw new DotgenError(`${file} has no \`export default defineConfig({ … })\`.`)
	}
	return parseConfig(module.default, file)
}

// A project's environments: every key that isn't a fixed one.
export function projectEnvs(project: Project): string[] {
	return Object.keys(project).filter((key) => !(reserved as readonly string[]).includes(key))
}

export function getProject(config: Config, name: string): Project {
	const project = config.projects[name]
	if (!project) {
		const known = Object.keys(config.projects).join(", ") || "(none)"
		throw new DotgenError(`Project "${name}" doesn't exist. Projects: ${known}.`)
	}
	return project
}

// The project whose `path` contains `cwd`; if several do, the one with the longest path.
export function detectProject(config: Config, cwd: string): string {
	const here = realPath(cwd)
	let best: { name: string; length: number } | undefined
	for (const [name, project] of Object.entries(config.projects)) {
		const root = realPath(project.path)
		const inside = here === root || here.startsWith(root.endsWith(sep) ? root : root + sep)
		if (inside && (!best || root.length > best.length)) best = { name, length: root.length }
	}
	if (!best) {
		throw new DotgenError(`${here} isn't inside any project. Use \`dotgen <project> <env>\`.`)
	}
	return best.name
}

// Fails if the project's `path` or any target's `dir` doesn't exist.
export function assertPaths(name: string, project: Pick<Project, "path" | "targets">) {
	const root = resolve(expandHome(project.path))
	if (!existsSync(root)) {
		throw new DotgenError(`projects.${name}.path: ${root} doesn't exist.`)
	}
	for (const [targetName, target] of Object.entries(project.targets)) {
		const dir = resolve(root, target.dir)
		if (!existsSync(dir)) {
			throw new DotgenError(`projects.${name}.targets.${targetName}.dir: ${dir} doesn't exist.`)
		}
	}
}
