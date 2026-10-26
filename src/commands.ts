import { spawnSync } from "node:child_process"
import { existsSync, readFileSync, statSync } from "node:fs"
import { relative, resolve } from "node:path"
import { parseArgs } from "node:util"
import { configPath, detectProject, expandHome, getProject, loadConfig } from "./config.ts"
import { DotgenError } from "./errors.ts"
import { checkConfig, generateProject } from "./generate.ts"
import { applyImport, discoverEnvFiles, envFromFileName, planImports } from "./import.ts"
import { initConfig, permissionWarning } from "./init.ts"
import { portRows, projectPorts, renderPorts } from "./ports.ts"
import { availableEnvs } from "./resolve.ts"
import type { Config } from "./schema.ts"
import { allConflicts, portConflicts } from "./conflicts.ts"
import { configObject, parseSource, SourceEditor } from "./edit.ts"
import { saveConfig } from "./save.ts"
import { assertSameValues, findShareCandidates, planShare } from "./share.ts"
import type { Chooser, GenerateReport, ImportOptions, ImportPlan, ShareCandidate, ShareOption, Tree, WriteStatus } from "./types.ts"
import { display, tildePath } from "./write.ts"

const usage = `Usage:
  dotgen init                     Create an example config
  dotgen edit                     Open the config in $EDITOR
  dotgen <env>                    Generate the project in the current folder
  dotgen <project> <env>          Generate that project
  dotgen all <env>                Generate that environment for every project
  dotgen check                    Validate everything without writing
  dotgen ports                    Show the port table per project
  dotgen ports <project> <seed> [<target>=<port> ...]
                                  Set the seed (backend = +1, frontend = +2) or explicit ports
  dotgen share                    Find values repeated across projects and pick which move to shared
  dotgen share --only <fields> | --yes [--skip <fields>] [--local <fields>]
                                  The same without prompting (comma-separated fields; a prefix includes everything below it)
  dotgen import <file> [env] [--project <name>] [--target <name>]
                                  Add or update the file's variables in the config
  dotgen import <folder> [env] [--project <name>]
                                  Find the env files under the folder and import them all

Options:
  --dry-run   Show which files would be written, without writing
  --force     Allow overwriting files dotgen didn't generate
  -v, --verbose
              Show values (secrets only by length) in import, share, and --dry-run`

const statusLabel: Record<WriteStatus, string> = {
	created: "created",
	updated: "updated",
	unchanged: "unchanged"
}

function warn(message: string) {
	console.error(`⚠ ${message}`)
}

async function load(): Promise<Config> {
	const file = configPath()
	const config = await loadConfig(file)
	const warning = permissionWarning(file)
	if (warning) warn(warning)
	return config
}

function printReport(report: GenerateReport, root: string, dryRun: boolean, verbose: boolean) {
	console.log(`${report.project} / ${report.env}${dryRun ? " (dry-run: nothing was written)" : ""}`)
	const width = Math.max(...report.files.map((file) => file.target.length))
	for (const file of report.files) {
		const count = file.kind === "env" ? ` (${report.entries[file.target]?.length ?? 0} variables)` : ""
		console.log(`  ${file.target.padEnd(width)}  ${statusLabel[file.status].padEnd(11)}  ${relative(root, file.file)}${count}`)
	}
	// Values only with `--verbose` (and masked).
	if (dryRun && verbose) {
		for (const [target, entries] of Object.entries(report.entries)) {
			console.log(`\n  ${target}`)
			for (const entry of entries) console.log(`    ${entry.name}=${display(entry.name, entry.value)}`)
		}
	}
	for (const warning of report.warnings) warn(warning)
}

// Per-variable detail only with `--verbose`; the summary always.
function printImport(plan: ImportPlan, dryRun: boolean, verbose: boolean) {
	console.log(`${plan.project} / ${plan.env} / ${plan.target}${dryRun ? " (dry-run: nothing was written)" : ""}`)
	if (plan.newProject) console.log(`  + project ${plan.project} (path ${plan.newProject.path})`)
	if (plan.newTarget) console.log(`  + target ${plan.target} (dir ${plan.newTarget.dir}, loader ${plan.newTarget.loader}: check it)`)
	const count = (kind: string) => plan.changes.filter((change) => change.kind === kind).length
	console.log(`  ${count("added")} added, ${count("updated")} changed, ${count("unchanged")} unchanged, ${count("covered")} already covered by shared/derive`)
	if (!verbose) return
	for (const change of plan.changes) {
		if (change.kind === "added") console.log(`    + ${change.name}=${display(change.name, change.value)}`)
		if (change.kind === "updated") {
			console.log(`    ~ ${change.name}: ${display(change.name, change.previous)} → ${display(change.name, change.value)}`)
		}
	}
}

function generate(config: Config, name: string, env: string, flags: { force: boolean; dryRun: boolean; verbose: boolean }) {
	const report = generateProject(config, name, env, { force: flags.force, dryRun: flags.dryRun, source: configPath() })
	printReport(report, resolve(expandHome(config.projects[name]!.path)), flags.dryRun, flags.verbose)
}

// Interactive multiselect; without a terminal there's no way to ask.
const clackChooser: Chooser = async (message, options) => {
	if (!process.stdin.isTTY || !process.stdout.isTTY) return undefined
	const { isCancel, multiselect } = await import("@clack/prompts")
	const result = await multiselect({ message, options, required: false })
	return isCancel(result) ? undefined : result
}

// No values unless `--verbose` (and masked even then): just the path and projects.
function shareOption(candidate: ShareCandidate, verbose: boolean): ShareOption {
	const where = `${candidate.env} · ${candidate.field}`
	const notes = candidate.redundant
		? [`already the same in shared: removed from ${candidate.projects.join(", ")}`]
		: [
				`same in: ${candidate.projects.join(", ")}`,
				...(candidate.receivers.length > 0 ? [`would also receive it: ${candidate.receivers.join(", ")}`] : []),
				...(candidate.overrides.length > 0 ? [`keeps its own: ${candidate.overrides.join(", ")}`] : [])
			]
	const label = verbose ? `${where} = ${display(candidate.name, candidate.value)}` : where
	return { value: candidate.id, label, hint: notes.join(" · ") }
}

// `dotgen ports <project> 5010` sets the seed (backend = 5011, frontend = 5012 with the
// default offsets); `backend=5011` sets an explicit port. Fails if anything collides.
async function setPorts(config: Config, args: string[], dryRun: boolean): Promise<number> {
	const [name, ...assignments] = args
	const project = getProject(config, name!)
	if (assignments.length === 0) throw new DotgenError("Usage: dotgen ports <project> <seed> | <target>=<port> [...]")
	let seed: number | undefined
	const ports: Record<string, number> = {}
	for (const assignment of assignments) {
		const match = /^(?:([A-Za-z][A-Za-z0-9_]*)=)?(\d+)$/.exec(assignment)
		const port = Number(match?.[2])
		if (!match || port < 1 || port > 65535) throw new DotgenError(`"${assignment}" isn't a <seed> or <target>=<port> (1-65535).`)
		if (match[1]) ports[match[1]] = port
		else seed = port
	}

	// Shallow copy with the changes, only to check collisions before writing.
	const projects = { ...config.projects }
	projects[name!] = Object.assign({}, project, seed === undefined ? {} : { seed }, { ports: { ...project.ports, ...ports } })
	const next = { ...config, projects }
	const conflicts = portConflicts(next)
	if (conflicts.length > 0) throw new DotgenError(conflicts.join("\n"))

	const before = projectPorts(config, name!, project)
	for (const [key, port] of Object.entries(projectPorts(next, name!, projects[name!]!))) {
		if (before[key] !== port) console.log(`  ${name}.${key}: ${before[key] ?? "new"} → ${port}`)
	}
	if (dryRun) {
		console.log("\n(dry-run: nothing was written)")
		return 0
	}
	const file = configPath()
	const editor = new SourceEditor(readFileSync(file, "utf8"))
	const change: Tree = {}
	if (seed !== undefined) change.seed = seed
	if (Object.keys(ports).length > 0) change.ports = ports
	editor.merge(configObject(parseSource(editor.source)), { projects: { [name!]: change } }, [])
	await saveConfig(file, editor.apply(), (after) => {
		const problems = portConflicts(after)
		if (problems.length > 0) throw new DotgenError(problems.join("\n"))
	})
	console.log(`\nSaved to ${tildePath(file)} (backup at ${tildePath(file)}.bak).`)
	return 0
}

// `backend.cookie` matches `backend.cookie` and all of `backend.cookie.*`.
function matchesField(field: string, patterns: string[]): boolean {
	return patterns.some((pattern) => field === pattern || field.startsWith(`${pattern}.`))
}

function list(value: string | undefined): string[] {
	return (value ?? "")
		.split(",")
		.map((item) => item.trim())
		.filter(Boolean)
}

async function share(
	config: Config,
	flags: { dryRun: boolean; yes: boolean; verbose: boolean; only: string[]; skip: string[]; local: string[] },
	choose: Chooser
): Promise<number> {
	const candidates = findShareCandidates(config)
	if (candidates.length === 0) {
		console.log("No values are repeated across projects.")
		return 0
	}
	const options = candidates.map((candidate) => shareOption(candidate, flags.verbose))
	const bySelection = flags.yes || flags.only.length > 0 || flags.local.length > 0
	if (flags.dryRun && !bySelection) {
		for (const option of options) console.log(`  ${option.label}\n    ${option.hint}`)
		return 0
	}

	let selected: string[]
	let local: string[] = []
	if (bySelection) {
		// With flags: `--only` picks; `--yes` picks all except `--skip`; `--local` marks.
		const chosen = candidates.filter((candidate) =>
			flags.only.length > 0 ? matchesField(candidate.field, flags.only) : flags.yes && !matchesField(candidate.field, flags.skip)
		)
		selected = chosen.map((candidate) => candidate.id)
		local = [...new Set(candidates.filter((candidate) => matchesField(candidate.field, flags.local)).map((candidate) => candidate.field))]
		const clash = local.filter((field) => chosen.some((candidate) => candidate.field === field))
		if (clash.length > 0) throw new DotgenError(`Can't move to shared and mark as local at the same time: ${clash.join(", ")}.`)
		const unknown = [...flags.only, ...flags.skip, ...flags.local].filter((pattern) => !candidates.some((candidate) => matchesField(candidate.field, [pattern])))
		if (unknown.length > 0) throw new DotgenError(`No repeated values match: ${unknown.join(", ")}.`)
	} else {
		const picked = await choose("Which ones should move to shared? (space selects, enter confirms)", options)
		if (!picked) {
			if (process.stdin.isTTY && process.stdout.isTTY) {
				console.log("Cancelled; nothing changed.")
				return 0
			}
			// No terminal: list them so they're visible, but there's no way to choose.
			for (const option of options) console.log(`  ${option.label}\n    ${option.hint}`)
			console.log("\nNothing changed. Run it in a terminal to choose, or use --yes to move them all.")
			return 1
		}
		selected = picked
		const rest = candidates.filter((candidate) => !selected.includes(candidate.id) && !candidate.redundant)
		if (rest.length > 0) {
			const fields = [...new Set(rest.map((candidate) => candidate.field))]
			const marked = await choose(
				"Which ones should be marked as local (never suggested again)?",
				fields.map((field) => ({ value: field, label: field }))
			)
			local = marked ?? []
		}
	}

	const chosen = candidates.filter((candidate) => selected.includes(candidate.id))
	if (chosen.length === 0 && local.length === 0) {
		console.log("Nothing changed.")
		return 0
	}
	if (flags.dryRun) {
		for (const candidate of chosen) console.log(`  → shared  ${candidate.env} · ${candidate.field}`)
		for (const field of local) console.log(`  → local   ${field}`)
		console.log("\n(dry-run: nothing was written)")
		return 0
	}
	const file = configPath()
	const source = planShare(readFileSync(file, "utf8"), chosen, local)
	const warnings = await saveConfig(file, source, (after) => {
		assertSameValues(config, after, chosen)
		return allConflicts(after)
	})
	for (const candidate of chosen) console.log(`  → shared  ${candidate.env} · ${candidate.field}`)
	for (const field of local) console.log(`  → local   ${field}`)
	console.log(`\nSaved to ${tildePath(file)} (backup at ${tildePath(file)}.bak).`)
	for (const warning of warnings) warn(warning)
	return 0
}

export async function main(argv: string[], io: { choose?: Chooser } = {}): Promise<number> {
	const { values, positionals } = parseArgs({
		args: argv,
		allowPositionals: true,
		options: {
			force: { type: "boolean", default: false },
			"dry-run": { type: "boolean", default: false },
			target: { type: "string" },
			project: { type: "string" },
			verbose: { type: "boolean", short: "v", default: false },
			yes: { type: "boolean", short: "y", default: false },
			only: { type: "string" },
			skip: { type: "string" },
			local: { type: "string" },
			help: { type: "boolean", short: "h", default: false }
		}
	})
	const flags = { force: values.force, dryRun: values["dry-run"], verbose: values.verbose }
	const [command, ...rest] = positionals

	if (!command || values.help) {
		console.log(usage)
		return command || values.help ? 0 : 1
	}

	if (command === "init") {
		for (const file of initConfig()) console.log(`created  ${tildePath(file)}`)
		return 0
	}

	if (command === "edit") {
		const file = configPath()
		if (!existsSync(file)) throw new DotgenError(`${tildePath(file)} doesn't exist. Create it with \`dotgen init\`.`)
		const editor = process.env.VISUAL || process.env.EDITOR || "vi"
		// Through the shell, to support editors with arguments (`code -w`).
		const result = spawnSync(`${editor} ${JSON.stringify(file)}`, { shell: true, stdio: "inherit" })
		return result.status ?? 1
	}

	const config = await load()

	if (command === "check") {
		const problems = checkConfig(config)
		for (const problem of problems) console.error(`✗ ${problem}`)
		if (problems.length === 0) console.log("Config is valid.")
		const repeated = findShareCandidates(config).length
		if (repeated > 0) warn(`${repeated} value(s) repeated across projects or equal to shared: review them with \`dotgen share\`.`)
		return problems.length === 0 ? 0 : 1
	}

	if (command === "share") {
		if (rest.length > 0) throw new DotgenError("Usage: dotgen share [--dry-run] [--yes]")
		const selection = { only: list(values.only), skip: list(values.skip), local: list(values.local) }
		if (selection.skip.length > 0 && !values.yes) throw new DotgenError("--skip goes with --yes (move all except those).")
		return share(config, { dryRun: flags.dryRun, yes: values.yes, verbose: values.verbose, ...selection }, io.choose ?? clackChooser)
	}

	if (command === "ports") {
		if (rest.length > 0) return setPorts(config, rest, flags.dryRun)
		const rows = portRows(config)
		console.log(renderPorts(rows))
		return rows.some((row) => row.conflict) ? 1 : 0
	}

	if (command === "import") {
		// Accepts `import <path> [env]` and `import <env> <path>`; the path is a file or a folder.
		if (rest.length === 0 || rest.length > 2) throw new DotgenError("Usage: dotgen import <file|folder> [env]")
		const pathIndex = rest.length === 2 && !existsSync(resolve(rest[0]!)) && existsSync(resolve(rest[1]!)) ? 1 : 0
		const path = resolve(rest[pathIndex]!)
		const explicitEnv = rest.length === 2 ? rest[1 - pathIndex]! : undefined
		if (!existsSync(path)) throw new DotgenError(`${path} doesn't exist.`)

		const items: ImportOptions[] = []
		if (statSync(path).isDirectory()) {
			if (values.target) throw new DotgenError("--target only applies when importing a file; with a folder, each subfolder is a target.")
			const discovery = discoverEnvFiles(path, explicitEnv)
			if (values.verbose) for (const skipped of discovery.skipped) console.log(`  skipped ${skipped}`)
			if (discovery.files.length === 0) throw new DotgenError(`No env files${explicitEnv ? ` for "${explicitEnv}"` : " with an environment"} found in ${path}.`)
			for (const item of discovery.files) items.push({ ...item, project: values.project, root: discovery.root })
		} else {
			const env = explicitEnv ?? envFromFileName(path)
			if (!env) throw new DotgenError(`Couldn't infer the environment from ${path}. Use: dotgen import <file> <env>`)
			items.push({ file: path, env, project: values.project, target: values.target })
		}

		const source = configPath()
		const current = readFileSync(source, "utf8")
		const plans = await planImports(config, current, source, items)
		for (const plan of plans) printImport(plan, flags.dryRun, values.verbose)
		if (flags.dryRun || plans.at(-1)!.source === current) return 0
		const warnings = await applyImport(plans, source)
		console.log(`\nSaved to ${tildePath(source)} (backup at ${tildePath(source)}.bak).`)
		for (const warning of warnings) warn(warning)
		for (const project of new Set(plans.filter((plan) => plan.newProject).map((plan) => plan.project))) {
			warn(`${project} has no \`ports\`: add them so dotgen can detect collisions.`)
		}
		return 0
	}

	if (command === "all") {
		const [env] = rest
		if (!env || rest.length > 1) throw new DotgenError("Usage: dotgen all <env>")
		const names = Object.entries(config.projects)
			.filter(([, project]) => availableEnvs(config, project).includes(env))
			.map(([name]) => name)
		if (names.length === 0) throw new DotgenError(`No project has the "${env}" environment.`)
		for (const name of names) generate(config, name, env, flags)
		return 0
	}

	if (rest.length > 1) throw new DotgenError(`Demasiados argumentos.\n\n${usage}`)
	const [name, env] = rest.length === 1 ? [command, rest[0]!] : [detectProject(config, process.cwd()), command]
	generate(config, name, env, flags)
	return 0
}
