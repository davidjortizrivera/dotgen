export type Scalar = string | number | boolean

// Nested object of values, as written in the config.
export interface Tree {
	[key: string]: Scalar | Tree
}

export type ScalarType = "string" | "number" | "boolean"

// A target's variable seen across every environment.
export interface EnvVar {
	name: string
	path: string[]
	// The value's type in each environment where it appears.
	types: Record<string, ScalarType>
	required: boolean
}

// Nested object for `env.ts`: each leaf is the expression that reads the variable.
export interface AccessorNode {
	[key: string]: AccessorNode | string
}

export type WriteStatus = "created" | "updated" | "unchanged"

export interface WriteOptions {
	// First line that marks the file as generated; without it the file isn't overwritten unless `force`.
	header: string
	mode?: number
	force?: boolean
	dryRun?: boolean
}

export interface WriteResult {
	file: string
	status: WriteStatus
	written: boolean
}

export type FileKind = "env" | "declarations" | "accessor"

export interface FileReport extends WriteResult {
	kind: FileKind
	target: string
}

export interface GenerateOptions {
	force?: boolean
	dryRun?: boolean
	// Only used for the environment file's header.
	source: string
}

export interface GenerateReport {
	project: string
	env: string
	files: FileReport[]
	warnings: string[]
	// Variables per target, for showing in `--dry-run`.
	entries: Record<string, Entry[]>
}

export interface PortEntry {
	key: string
	port: number
	// Where it comes from, for messages: `projects.myapp.seed + 1 (backend)` or `projects.myapp.ports.backend`.
	source: string
}

export interface PortRow {
	project: string
	key: string
	port: number
	// `seed 5010 + 1` or `ports`.
	origin: string
	conflict?: string
}

// A value repeated across projects that can be moved to `shared.<env>.<target>`.
export interface ShareCandidate {
	// `<env>:<target>.<path>`, to identify it in the selection.
	id: string
	env: string
	target: string
	path: string[]
	// `<target>.<path>`, as written in `unique` and `local`.
	field: string
	name: string
	value: Scalar
	// Have this value: it's removed from them.
	projects: string[]
	// Have the target but not the path: they'd start receiving it.
	receivers: string[]
	// Have a different value: they keep theirs.
	overrides: string[]
	// Already equal in `shared`: it's only removed from the projects.
	redundant: boolean
}

export interface ShareOption {
	value: string
	label: string
	hint?: string
}

// Picks among options; `undefined` if the user cancels.
export type Chooser = (message: string, options: ShareOption[]) => Promise<string[] | undefined>

// Paths to remove from the config: `true` on the leaf being removed.
export interface RemovalTree {
	[key: string]: true | RemovalTree
}

export interface TextEdit {
	start: number
	end: number
	text: string
}

export type ImportChange =
	| { kind: "added"; name: string; value: Scalar }
	| { kind: "updated"; name: string; value: Scalar; previous: Scalar }
	| { kind: "unchanged"; name: string }
	// Already produced by `shared` or `derive` with the same value.
	| { kind: "covered"; name: string }

export interface ImportPlan {
	project: string
	env: string
	target: string
	newProject?: { path: string }
	newTarget?: { dir: string; loader: "bun" | "vite" | "node" }
	changes: ImportChange[]
	// The new contents of `config.ts`; the same as the current one if nothing changed.
	source: string
}

export interface ImportOptions {
	file: string
	env: string
	project?: string
	target?: string
	// Root for a new project; without it, the git repo's root is used.
	root?: string
}

export interface Discovery {
	root: string
	files: Array<{ file: string; env: string; target: string }>
	// Environment files that aren't imported: no environment, `.local`, templates.
	skipped: string[]
}

// A flattened leaf of the tree: its path, variable name, and value.
export interface Entry {
	path: string[]
	name: string
	value: Scalar
}
