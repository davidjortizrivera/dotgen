import { existsSync, readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { renderAccessor } from "./accessor.ts"
import { assertPaths, getProject } from "./config.ts"
import { allConflicts, assertNoConflicts } from "./conflicts.ts"
import { collectVars, declarationsPath, projectRoot, renderDeclarations, tsconfigWarning, tsHeader } from "./declarations.ts"
import { DotgenError } from "./errors.ts"
import { flatten } from "./names.ts"
import { availableEnvs, resolveProject } from "./resolve.ts"
import type { Config, Target } from "./schema.ts"
import type { Entry, FileKind, GenerateOptions, GenerateReport } from "./types.ts"
import { envHeader, gitignoreWarning, renderEnvFile, writeGenerated } from "./write.ts"

export function envFilePath(root: string, target: Target, env: string): string {
	return resolve(root, target.dir, `.env.${env}`)
}

// `env.ts` goes next to the types file.
export function accessorPath(root: string, target: Target): string {
	return join(dirname(declarationsPath(root, target)), "env.ts")
}

// A target's typed files (the same for every environment).
function typedFiles(config: Config, name: string, targetName: string, target: Target, root: string) {
	const vars = collectVars(config, name, targetName)
	const files: Array<{ kind: FileKind; file: string; content: string }> = [
		{ kind: "declarations", file: declarationsPath(root, target), content: renderDeclarations({ vars, loader: target.loader }) }
	]
	if (target.accessor) {
		const content = renderAccessor({ vars, loader: target.loader, prefix: `projects.${name}.${targetName}` })
		files.push({ kind: "accessor", file: accessorPath(root, target), content })
	}
	return files
}

export function generateProject(config: Config, name: string, env: string, options: GenerateOptions): GenerateReport {
	const { force, dryRun, source } = options
	const project = getProject(config, name)
	assertPaths(name, project)
	assertNoConflicts(config)

	const root = projectRoot(project.path)
	const values = resolveProject(config, name, env)
	const report: GenerateReport = { project: name, env, files: [], warnings: [], entries: {} }

	// Render everything first, so a failure doesn't leave a project half-written.
	const pending: Array<{ kind: FileKind; target: string; file: string; content: string }> = []
	for (const [targetName, target] of Object.entries(project.targets)) {
		const entries: Entry[] = flatten(values[targetName] ?? {}, [targetName])
		report.entries[targetName] = entries
		const file = envFilePath(root, target, env)
		pending.push({ kind: "env", target: targetName, file, content: renderEnvFile({ entries, loader: target.loader, project: name, env, source }) })
		for (const typed of typedFiles(config, name, targetName, target, root)) pending.push({ ...typed, target: targetName })
	}

	const writeOptions = (kind: FileKind) => ({
		header: kind === "env" ? envHeader : tsHeader,
		mode: kind === "env" ? 0o600 : undefined,
		force
	})
	// Dry pass: if any existing file isn't dotgen's, none get written.
	for (const item of pending) writeGenerated(item.file, item.content, { ...writeOptions(item.kind), dryRun: true })

	for (const item of pending) {
		const isEnv = item.kind === "env"
		const result = writeGenerated(item.file, item.content, { ...writeOptions(item.kind), dryRun })
		report.files.push({ ...result, kind: item.kind, target: item.target })
		const warning = isEnv ? gitignoreWarning(item.file) : undefined
		if (warning) report.warnings.push(warning)
		if (item.kind === "declarations") {
			const tsconfig = tsconfigWarning(resolve(root, project.targets[item.target]!.dir), item.file)
			if (tsconfig) report.warnings.push(tsconfig)
		}
	}
	return report
}

function attempt(problems: string[], label: string, action: () => void) {
	try {
		action()
	} catch (error) {
		if (!(error instanceof DotgenError)) throw error
		problems.push(`${label}: ${error.message}`)
	}
}

// Validates everything without writing: names, values, conflicts, paths, and stale typed files.
export function checkConfig(config: Config): string[] {
	const problems = [...allConflicts(config)]
	for (const [name, project] of Object.entries(config.projects)) {
		attempt(problems, name, () => assertPaths(name, project))
		const root = projectRoot(project.path)
		for (const env of availableEnvs(config, project)) {
			attempt(problems, `${name} / ${env}`, () => {
				const values = resolveProject(config, name, env)
				for (const [targetName, target] of Object.entries(project.targets)) {
					const entries = flatten(values[targetName] ?? {}, [targetName])
					renderEnvFile({ entries, loader: target.loader, project: name, env, source: "" })
				}
			})
		}
		for (const [targetName, target] of Object.entries(project.targets)) {
			attempt(problems, `${name} / ${targetName}`, () => {
				for (const typed of typedFiles(config, name, targetName, target, root)) {
					if (!existsSync(typed.file)) problems.push(`${typed.file} doesn't exist: run \`dotgen ${name} <env>\`.`)
					else if (readFileSync(typed.file, "utf8") !== typed.content) problems.push(`${typed.file} is out of date.`)
				}
			})
		}
	}
	return problems
}
