import { spawnSync } from "node:child_process"
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { basename, dirname, join, relative, resolve, sep } from "node:path"
import { detectProject, loadConfig, projectEnvs, realPath } from "./config.ts"
import { allConflicts } from "./conflicts.ts"
import { configObject, parseSource, SourceEditor } from "./edit.ts"
import { DotgenError } from "./errors.ts"
import { merge } from "./merge.ts"
import { flatten, toEnvName } from "./names.ts"
import { availableEnvs, resolveProject } from "./resolve.ts"
import { saveConfig } from "./save.ts"
import type { Config, Loader, Project } from "./schema.ts"
import type { Discovery, Entry, ImportChange, ImportOptions, ImportPlan, Scalar, Tree } from "./types.ts"
import { tildePath } from "./write.ts"

// Minimal env file parser: comments, `export`, single, double, and backtick quotes,
// `\$` and `\n` inside double quotes, and trailing comments after unquoted values.
// If a name repeats, the last one wins (same as the loaders).
export function parseEnvFile(text: string): Map<string, string> {
	const result = new Map<string, string>()
	const pattern = /^[ \t]*(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*=[ \t]*(?:"((?:\\.|[^"\\])*)"|'([^']*)'|`([^`]*)`|([^\n#]*?))[ \t]*(?:#[^\n]*)?$/gm
	for (const match of text.matchAll(pattern)) {
		const [, name, double, single, backtick, bare] = match
		const value =
			double !== undefined
				? double.replace(/\\([n$"])/g, (all, char: string) => (char === "n" ? "\n" : char))
				: (single ?? backtick ?? bare ?? "")
		result.set(name!, value)
	}
	return result
}

// What the value probably was in the config, only if it round-trips exactly (`"1.50"` stays a string).
export function guessScalar(value: string): Scalar {
	if (value === "true") return true
	if (value === "false") return false
	const number = Number(value)
	if (value.trim() !== "" && Number.isFinite(number) && String(number) === value) return number
	return value
}

function camel(words: string[]): string {
	return words.map((word, index) => (index === 0 ? word.toLowerCase() : word.charAt(0) + word.slice(1).toLowerCase())).join("")
}

// A key that produces exactly `words`; if camelCase can't (`X_2FA`), the name as-is.
function leafKey(words: string[]): string {
	const key = camel(words)
	return /^[A-Za-z]/.test(key) && toEnvName([key]) === words.join("_") ? key : words.join("_")
}

// `DATABASE_SERVER` can come from `database.server` or from `databaseServer`. The variable's
// first word is always an object (`RESEND_TOKEN` → `resend.token`); deeper levels are only
// grouped when two or more variables share a prefix (`M3_DRY_RUN` → `m3.dryRun`, not `m3.dry.run`).
// `depth` is how many of the variable's words the target object already consumed.
export function toTree(items: Array<[string[], Scalar]>, depth = 0): Tree {
	const tree: Tree = {}
	const byHead = new Map<string, Array<[string[], Scalar]>>()
	for (const item of items) {
		const head = item[0][0]!
		byHead.set(head, [...(byHead.get(head) ?? []), item])
	}
	for (const [head, list] of byHead) {
		const nested = list.filter(([words]) => words.length > 1)
		const key = head.toLowerCase()
		// With both `DATABASE` and `DATABASE_SERVER`, the plain value doesn't fit in the object: don't group.
		const enough = depth === 0 ? nested.length >= 1 : nested.length >= 2
		// Nor when the rest starts with a digit (`X_2FA` → `x.2FA` isn't a valid key).
		const validRest = nested.every(([words]) => /^[A-Za-z]/.test(words[1]!))
		const canGroup = enough && validRest && nested.length === list.length && /^[a-z]/.test(key) && toEnvName([key]) === head
		if (canGroup) tree[key] = toTree(nested.map(([words, value]) => [words.slice(1), value]), depth + 1)
		else for (const [words, value] of list) tree[leafKey(words)] = value
	}
	return tree
}

// Keeps the type the value already had in the config, if the text allows it.
export function coerceLike(raw: string, previous: Scalar): Scalar {
	if (typeof previous === "number") {
		const number = Number(raw)
		return raw.trim() !== "" && String(number) === raw ? number : raw
	}
	if (typeof previous === "boolean") return raw === "true" ? true : raw === "false" ? false : raw
	return raw
}

function setAt(tree: Tree, path: string[], value: Scalar | Tree) {
	let node = tree
	for (const key of path.slice(0, -1)) {
		node[key] ??= {}
		node = node[key] as Tree
	}
	node[path.at(-1)!] = value
}

// Paths of every object in the tree, deepest first, including the root.
function objectPaths(tree: Tree, path: string[] = []): string[][] {
	const nested = Object.entries(tree).flatMap(([key, value]) => (typeof value === "object" ? objectPaths(value, [...path, key]) : []))
	return [...nested, path].sort((a, b) => b.length - a.length)
}

// New variables placed inside the existing object they belong to:
// with `database: { … }` in the config, `DATABASE_NAME` goes to `database.name`.
export function placeNew(own: Tree, added: Array<[string, Scalar]>): Tree {
	const anchors = objectPaths(own)
	const groups = new Map<string, { path: string[]; items: Array<[string[], Scalar]> }>()
	for (const [name, value] of added) {
		const anchor = anchors.find((path) => path.length === 0 || name.startsWith(`${toEnvName(path)}_`))!
		const rest = path(anchor, name)
		const key = anchor.join(".")
		const group = groups.get(key) ?? { path: anchor, items: [] }
		group.items.push([rest, value])
		groups.set(key, group)
	}
	let result: Tree = {}
	for (const group of groups.values()) {
		// Inside an existing object (`database`), the first word is already consumed.
		const tree = toTree(group.items, group.path.length)
		result = merge(result, group.path.length === 0 ? tree : nest(group.path, tree))
	}
	return result

	function path(anchor: string[], name: string): string[] {
		const prefix = anchor.length === 0 ? "" : `${toEnvName(anchor)}_`
		return name.slice(prefix.length).split("_").filter(Boolean)
	}
}

function nest(path: string[], value: Tree): Tree {
	const tree: Tree = {}
	setAt(tree, path, value)
	return tree
}

// `index.html` is what marks a Vite app: a backend may have `vite.config.ts` just for
// vitest. Without `index.html`, a Bun lockfile wins over `vite.config.*`.
export function guessLoader(dir: string, root: string): Loader {
	if (existsSync(join(dir, "index.html"))) return "vite"
	const bun = [dir, root].some((base) => ["bun.lock", "bun.lockb", "bunfig.toml"].some((file) => existsSync(join(base, file))))
	if (bun) return "bun"
	const vite = ["ts", "mts", "js", "mjs", "cjs"].some((ext) => existsSync(join(dir, `vite.config.${ext}`)))
	return vite ? "vite" : "node"
}

function gitRoot(dir: string): string | undefined {
	const result = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: dir, encoding: "utf8" })
	return result.status === 0 ? realPath(result.stdout.trim()) : undefined
}

// `newRoot` is the root for a new project (the folder passed to `import`); without it, the git repo's root.
function locateProject(config: Config, dir: string, explicit?: string, newRoot?: string): { name: string; project?: Project; root: string } {
	if (explicit && config.projects[explicit]) {
		return { name: explicit, project: config.projects[explicit], root: realPath(config.projects[explicit].path) }
	}
	if (!explicit) {
		try {
			const name = detectProject(config, dir)
			return { name, project: config.projects[name], root: realPath(config.projects[name]!.path) }
		} catch {
			// Not in any project: create a new one.
		}
	}
	const root = newRoot ? realPath(newRoot) : gitRoot(dir)
	if (!root) throw new DotgenError(`${dir} isn't in a git repo or in any project in the config, so the project root can't be inferred.`)
	const name = explicit ?? basename(root)
	if (config.projects[name]) throw new DotgenError(`A project named "${name}" already exists with a different path. Use --project <name>.`)
	return { name, root }
}

function byName(entries: Entry[]): Map<string, Entry> {
	return new Map(entries.map((entry) => [entry.name, entry]))
}

// Computes the changes and the new `config.ts` content without writing anything.
export function planImport(config: Config, source: string, options: ImportOptions): ImportPlan {
	const { file, env } = options
	const path = resolve(file)
	if (!existsSync(path)) throw new DotgenError(`${path} doesn't exist.`)
	const dir = realPath(dirname(path))
	const pairs = parseEnvFile(readFileSync(path, "utf8"))

	const located = locateProject(config, dir, options.project, options.root)
	const { name, project, root } = located
	const existingTarget = Object.entries(project?.targets ?? {}).find(([, target]) => realPath(resolve(root, target.dir)) === dir)?.[0]
	const target = existingTarget ?? options.target ?? (dir === root ? "app" : basename(dir))
	if (!existingTarget && project?.targets[target]) {
		throw new DotgenError(`Target "${target}" of ${name} points to a different folder (${project.targets[target]!.dir}). Use --target <name>.`)
	}

	const own = (project && projectEnvs(project).includes(env) ? (project[env] as Record<string, Tree>)[target] : undefined) ?? {}
	const ownEntries = byName(flatten(own, [target]))
	// With an environment that's new to the project, only `shared` can cover values.
	const resolved =
		project && availableEnvs(config, project).includes(env) ? (resolveProject(config, name, env)[target] ?? {}) : (config.shared?.[env]?.[target] ?? {})
	const resolvedEntries = byName(flatten(resolved, [target]))

	const changes: ImportChange[] = []
	const updates: Tree = {}
	const added: Array<[string, Scalar]> = []
	for (const [variable, raw] of pairs) {
		const current = ownEntries.get(variable)
		if (current) {
			if (String(current.value) === raw) changes.push({ kind: "unchanged", name: variable })
			else {
				const value = coerceLike(raw, current.value)
				changes.push({ kind: "updated", name: variable, value, previous: current.value })
				setAt(updates, current.path, value)
			}
		} else if (resolvedEntries.has(variable) && String(resolvedEntries.get(variable)!.value) === raw) {
			changes.push({ kind: "covered", name: variable })
		} else {
			const value = guessScalar(raw)
			changes.push({ kind: "added", name: variable, value })
			added.push([variable, value])
		}
	}

	// New ones follow the shape the target already has across all its layers (`shared` included),
	// so `databaseServer` isn't created when `shared` already uses `database.server`.
	const shape = merge(resolved, own)
	const tree = merge(updates, placeNew(shape, added))
	// Each variable must produce its own name again (`A__B` can't) with no collisions.
	const produced = byName(flatten(merge(shape, tree), [target]))
	const lost = added.map(([variable]) => variable).filter((variable) => !produced.has(variable))
	if (lost.length > 0) throw new DotgenError(`These can't be expressed as a nested path: ${lost.join(", ")}.`)

	const newProject = project ? undefined : { path: tildePath(root) }
	const newTarget = existingTarget ? undefined : { dir: relative(root, dir) || ".", loader: guessLoader(dir, root) }
	const plan: ImportPlan = { project: name, env, target, newProject, newTarget, changes, source }
	if (!newProject && !newTarget && Object.keys(tree).length === 0) return plan

	const editor = new SourceEditor(source)
	const projectTree: Tree = {}
	if (newProject) projectTree.path = newProject.path
	if (newTarget) projectTree.targets = { [target]: { dir: newTarget.dir, loader: newTarget.loader } }
	projectTree[env] = { [target]: tree }
	editor.merge(configObject(parseSource(source)), { projects: { [name]: projectTree } }, [])
	return { ...plan, source: editor.apply() }
}

// Loads config content that isn't on disk yet. The temp file sits next to the real config
// so `import … from "<package>"` resolves the same way.
export async function loadSource(source: string, file: string): Promise<Config> {
	const temp = join(dirname(file), `.config.import-${process.pid}.ts`)
	writeFileSync(temp, source, { mode: 0o600 })
	try {
		return await loadConfig(temp)
	} finally {
		rmSync(temp, { force: true })
	}
}

// Plans several files in sequence: each sees the config the previous one left
// (e.g. the frontend finds the project the backend created). Writes nothing.
export async function planImports(config: Config, source: string, file: string, items: ImportOptions[]): Promise<ImportPlan[]> {
	const plans: ImportPlan[] = []
	let current = config
	let text = source
	for (const item of items) {
		const plan = planImport(current, text, item)
		plans.push(plan)
		if (plan.source !== text) {
			text = plan.source
			current = await loadSource(text, file)
		}
	}
	return plans
}

// Writes the final result to `config.ts`, backed up to `config.ts.bak`. Reloads and validates
// every project/environment touched; if anything fails, restores the previous one. Returns warnings.
export async function applyImport(plans: ImportPlan[], file: string): Promise<string[]> {
	const last = plans.at(-1)
	if (!last) return []
	return saveConfig(file, last.source, (config) => {
		for (const plan of plans) {
			const values = resolveProject(config, plan.project, plan.env)
			for (const [target, tree] of Object.entries(values)) flatten(tree, [target])
		}
		return allConflicts(config)
	})
}

const envPrefix = ".env"
const ignoredDirs = new Set(["node_modules", "dist", "build", "out", "coverage", "vendor", "target", "tmp"])
// Suffixes that aren't environments: local overrides, templates, and copies.
const notEnvs = new Set(["local", "example", "sample", "template", "dist", "defaults", "bak"])

// Finds env files with an environment under `root`, skipping hidden and build folders.
// Each folder with files is a target; if two folders share a name, the target uses the path.
export function discoverEnvFiles(root: string, env?: string): Discovery {
	const base = realPath(root)
	const found: Array<{ file: string; env: string; dir: string }> = []
	const skipped: string[] = []

	function walk(dir: string, depth: number) {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const path = join(dir, entry.name)
			if (entry.isDirectory()) {
				if (depth < 5 && !entry.name.startsWith(".") && !ignoredDirs.has(entry.name)) walk(path, depth + 1)
				continue
			}
			if (!entry.isFile() || !entry.name.startsWith(envPrefix)) continue
			const fileEnv = envFromFileName(entry.name)
			if (fileEnv && !notEnvs.has(fileEnv)) {
				if (!env || fileEnv === env) found.push({ file: path, env: fileEnv, dir })
			} else {
				skipped.push(relative(base, path))
			}
		}
	}
	walk(base, 0)

	const baseName = (dir: string) => (dir === base ? "app" : basename(dir))
	const counts = new Map<string, number>()
	for (const dir of new Set(found.map((item) => item.dir))) counts.set(baseName(dir), (counts.get(baseName(dir)) ?? 0) + 1)
	const targetOf = (dir: string) => (counts.get(baseName(dir))! > 1 && dir !== base ? relative(base, dir).split(sep).join("-") : baseName(dir))

	const files = found
		.map((item) => ({ file: item.file, env: item.env, target: targetOf(item.dir) }))
		.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))
	return { root: base, files, skipped: skipped.sort() }
}

// `.env.development` → `development`. `.local` and similar files need the environment given explicitly.
export function envFromFileName(file: string): string | undefined {
	const match = /^\.env\.([A-Za-z0-9_-]+)$/.exec(basename(file))
	return match?.[1]
}
