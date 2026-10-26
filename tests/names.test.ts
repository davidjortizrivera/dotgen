import { describe, expect, it } from "vitest"
import { flatten, toEnvName } from "../src/names.ts"
import type { Tree } from "../src/types.ts"

describe("toEnvName", () => {
	it.each([
		[["database", "server"], "DATABASE_SERVER"],
		[["m3", "dryRun"], "M3_DRY_RUN"],
		[["api", "baseURL"], "API_BASE_URL"],
		[["oauth2", "clientId"], "OAUTH2_CLIENT_ID"],
		[["vite", "frontendUrl"], "VITE_FRONTEND_URL"],
		[["NODE_ENV"], "NODE_ENV"],
		[["URLPath"], "URL_PATH"],
		[["http2Server"], "HTTP2_SERVER"],
		[["ioRedis"], "IO_REDIS"],
		[["jwtTTL"], "JWT_TTL"],
		[["already_snake"], "ALREADY_SNAKE"],
		[["S3"], "S3"]
	])("%j → %s", (path, name) => {
		expect(toEnvName(path)).toBe(name)
	})

	it.each(["", "2fa", "has-dash", "has space", "é"])("rejects the key %j", (key) => {
		expect(() => toEnvName([key])).toThrow(/Invalid key/)
	})
})

describe("flatten", () => {
	it("flattens and sorts by name", () => {
		const tree: Tree = { m3: { dryRun: true }, database: { server: "db", port: 1433 } }
		expect(flatten(tree).map((entry) => [entry.name, entry.value])).toEqual([
			["DATABASE_PORT", 1433],
			["DATABASE_SERVER", "db"],
			["M3_DRY_RUN", true]
		])
	})

	it("detects two paths with the same name", () => {
		const tree: Tree = { database: { server: "a" }, databaseServer: "b" }
		expect(() => flatten(tree)).toThrow("database.server and databaseServer produce the same name DATABASE_SERVER.")
	})

	it("includes the prefix in messages", () => {
		const tree: Tree = { database: { server: "a" }, databaseServer: "b" }
		expect(() => flatten(tree, ["backend"])).toThrow("backend.database.server and backend.databaseServer")
	})

	it.each([
		[null, "null"],
		[undefined, "undefined"],
		[["a"], "an array"]
	])("rejects %j", (value, label) => {
		const tree = { database: { name: value } } as unknown as Tree
		expect(() => flatten(tree)).toThrow(`database.name: ${label} isn't allowed`)
	})
})
