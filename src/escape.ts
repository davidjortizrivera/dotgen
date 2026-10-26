import { DotgenError } from "./errors.ts"
import type { Loader } from "./schema.ts"
import type { Scalar } from "./types.ts"

// Escape matrix results (vite 8.3.1, bun 1.3.14, node 26.10), always inside double quotes:
//
//               `$`            `\$`        `\n`        `\\`, `\x`     `\"`
//   bun, vite   expands        → `$`       → newline   unchanged      broken (bun keeps `\"`, vite cuts)
//   node        literal        → `\$`      → newline   unchanged      broken (cuts)
//
// Bun and vite expand `$` even inside single quotes, so those can't be used for output.
// Anything the matrix didn't test, or that no loader reads correctly, is an error instead of a guess.
function reject(name: string, reason: string): never {
	throw new DotgenError(`${name}: the value ${reason}, and can't be written so that every loader reads it the same way.`)
}

export function escapeValue(name: string, value: Scalar, loader: Loader): string {
	const text = String(value)

	if (text.includes('"')) reject(name, "contains double quotes")
	// Any control character except newline (which is written as `\n`).
	if (/[\u0000-\u0009\u000B-\u001F\u007F]/.test(text)) reject(name, "contains control characters")
	if (text.includes("\\n")) reject(name, 'contains `\\` followed by "n", which would be read as a newline')
	if (text.endsWith("\\")) reject(name, "ends with `\\`, which would escape the closing quote")
	if (loader !== "node" && text.includes("\\$")) reject(name, "contains `\\` before `$`")

	let escaped = text.replaceAll("\n", "\\n")
	if (loader !== "node") escaped = escaped.replaceAll("$", "\\$")
	return `"${escaped}"`
}
