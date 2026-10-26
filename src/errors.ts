// An expected dotgen error: the CLI prints the message without a stack and exits with a non-zero code.
export class DotgenError extends Error {
	override name = "DotgenError"
}
