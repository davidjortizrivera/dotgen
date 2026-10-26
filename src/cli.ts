#!/usr/bin/env node
import { main } from "./commands.ts"
import { DotgenError } from "./errors.ts"

function expected(error: unknown): error is Error {
	if (error instanceof DotgenError) return true
	// `parseArgs` errors (unknown option, missing value for --target, …).
	const code = (error as { code?: unknown } | null)?.code
	return typeof code === "string" && code.startsWith("ERR_PARSE_ARGS")
}

main(process.argv.slice(2)).then(
	(code) => process.exit(code),
	(error: unknown) => {
		if (!expected(error)) throw error
		console.error(`✗ ${error.message}`)
		process.exit(1)
	}
)
