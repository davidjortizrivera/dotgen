import type { Config, Derive, Target } from "./schema.ts"
import type { Tree } from "./types.ts"

export type { Config, Derive, DeriveContext, Loader, Project, Target } from "./schema.ts"
export type { Scalar, Tree } from "./types.ts"

// Values per target: `{ backend: { database: { … } } }`.
export type TargetValues = Record<string, Tree>

export interface ProjectFixed {
	path: string
	seed?: number
	ports?: Record<string, number>
	targets: Record<string, Target>
	derive?: Derive
}

// Fixed keys keep their type; any other key is an environment.
export type ProjectInput<T> = ProjectFixed & {
	[K in keyof T]: K extends keyof ProjectFixed ? ProjectFixed[K] : TargetValues
}

export interface ConfigInput<P> {
	unique?: string[]
	local?: string[]
	portOffsets?: Record<string, number>
	shared?: Record<string, TargetValues>
	projects: { [N in keyof P]: ProjectInput<P[N]> }
}

// Typed identity: only provides autocomplete in `config.ts`; validation happens on load.
export function defineConfig<P>(config: ConfigInput<P>): Config {
	return config as unknown as Config
}
