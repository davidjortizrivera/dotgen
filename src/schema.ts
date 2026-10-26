import { z } from "zod"
import type { Scalar, Tree } from "./types.ts"

const scalar: z.ZodType<Scalar> = z.union([z.string(), z.number(), z.boolean()])

export const tree: z.ZodType<Tree> = z.lazy(() => z.record(z.string(), z.union([scalar, tree])))

// Values per target: `{ backend: { database: { … } } }`.
export const targetValues = z.record(z.string(), tree)

export const loader = z.enum(["bun", "vite", "node"])

export const target = z.strictObject({
	dir: z.string().min(1),
	loader,
	accessor: z.boolean().optional(),
	types: z.string().min(1).optional()
})

export const port = z.number().int().min(1).max(65535)

export interface DeriveContext {
	project: string
	env: string
	port: Record<string, number>
	values: Record<string, Tree>
}

export type Derive = (context: DeriveContext) => Record<string, Tree>

const derive = z.custom<Derive>((value) => typeof value === "function", { message: "derive must be a function" })

// The project's fixed keys; any other key is an environment.
export const reserved = ["path", "seed", "ports", "targets", "derive"] as const

export const project = z
	.object({
		path: z.string().min(1),
		// Port seed: each target gets `seed + portOffsets[target]`.
		seed: port.optional(),
		ports: z.record(z.string(), port).optional(),
		targets: z.record(z.string(), target),
		derive: derive.optional()
	})
	.catchall(targetValues)

export const config = z.strictObject({
	unique: z.array(z.string().min(1)).optional(),
	// Per-project fields that `dotgen share` won't offer to move into `shared`.
	local: z.array(z.string().min(1)).optional(),
	// Each target's offset over `seed`; defaults to `{ backend: 1, frontend: 2 }`.
	portOffsets: z.record(z.string(), z.number().int().min(0).max(999)).optional(),
	shared: z.record(z.string(), targetValues).optional(),
	projects: z.record(z.string(), project)
})

export type Loader = z.infer<typeof loader>
export type Target = z.infer<typeof target>
export type Project = z.infer<typeof project>
export type Config = z.infer<typeof config>
