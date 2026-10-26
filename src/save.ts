import { chmodSync, copyFileSync, writeFileSync } from "node:fs"
import { loadConfig } from "./config.ts"
import { DotgenError } from "./errors.ts"
import type { Config } from "./schema.ts"

// Writes `source` to `config.ts` with a backup in `config.ts.bak`, reloads the config, and passes it
// to `validate`. If anything fails, restores the previous one. Returns whatever `validate` returns.
export async function saveConfig<T>(file: string, source: string, validate: (config: Config) => T): Promise<T> {
	const backup = `${file}.bak`
	copyFileSync(file, backup)
	chmodSync(backup, 0o600)
	writeFileSync(file, source)
	chmodSync(file, 0o600)
	try {
		return validate(await loadConfig(file))
	} catch (error) {
		copyFileSync(backup, file)
		const reason = error instanceof Error ? error.message : String(error)
		throw new DotgenError(`The edited config is invalid; the previous one was restored.\n${reason}`)
	}
}
