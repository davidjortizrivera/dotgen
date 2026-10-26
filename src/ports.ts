import type { Config, Project } from "./schema.ts"
import type { PortEntry, PortRow } from "./types.ts"

// Default offsets over the seed: backend = seed + 1, frontend = seed + 2.
export const defaultPortOffsets: Record<string, number> = { backend: 1, frontend: 2 }

// A project's ports: those computed from `seed` with `portOffsets`, overlaid with the explicit
// ones from `ports` (which win). `source` says where each came from, for messages.
export function portEntries(config: Config, name: string, project: Project): PortEntry[] {
	const offsets = config.portOffsets ?? defaultPortOffsets
	const entries = new Map<string, PortEntry>()
	if (project.seed !== undefined) {
		for (const [key, offset] of Object.entries(offsets)) {
			entries.set(key, { key, port: project.seed + offset, source: `projects.${name}.seed + ${offset} (${key})` })
		}
	}
	for (const [key, port] of Object.entries(project.ports ?? {})) {
		entries.set(key, { key, port, source: `projects.${name}.ports.${key}` })
	}
	return [...entries.values()]
}

export function projectPorts(config: Config, name: string, project: Project): Record<string, number> {
	return Object.fromEntries(portEntries(config, name, project).map((entry) => [entry.key, entry.port]))
}

// Every port, sorted by number, with collisions flagged.
export function portRows(config: Config): PortRow[] {
	const rows: PortRow[] = []
	for (const [name, project] of Object.entries(config.projects)) {
		for (const entry of portEntries(config, name, project)) {
			const origin = entry.source.includes(".seed") ? `seed ${project.seed} + ${entry.port - project.seed!}` : "ports"
			rows.push({ project: name, key: entry.key, port: entry.port, origin })
		}
	}
	rows.sort((a, b) => a.port - b.port || (a.project < b.project ? -1 : 1))
	for (const row of rows) {
		const other = rows.find((item) => item !== row && item.port === row.port)
		if (other) row.conflict = `${other.project}.${other.key}`
	}
	return rows
}

export function renderPorts(rows: PortRow[]): string {
	if (rows.length === 0) return "No ports registered."
	const header = ["PORT", "PROJECT", "TARGET", "ORIGIN", ""]
	const table = [header, ...rows.map((row) => [String(row.port), row.project, row.key, row.origin, row.conflict ? `✗ collides with ${row.conflict}` : ""])]
	const widths = header.map((_, column) => Math.max(...table.map((line) => line[column]!.length)))
	return table.map((line) => line.map((cell, column) => cell.padEnd(widths[column]!)).join("  ").trimEnd()).join("\n")
}
