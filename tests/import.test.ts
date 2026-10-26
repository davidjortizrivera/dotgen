import { describe, expect, it } from "vitest"
import { coerceLike, guessScalar, parseEnvFile, placeNew, toTree } from "../src/import.ts"

describe("parseEnvFile", () => {
	it("handles quotes, escapes, export, and comments", () => {
		const text = [
			"# comment",
			"",
			'DATABASE_PASSWORD="abc\\$defgh123"',
			"SINGLE='a$b'",
			"export BARE=hello # comment",
			'MULTI="a\\nb"',
			"EMPTY=",
			'QUOTE="a\\"b"',
			"BACKTICK=`x y`",
			"BARE=overridden"
		].join("\n")
		expect(Object.fromEntries(parseEnvFile(text))).toEqual({
			DATABASE_PASSWORD: "abc$defgh123",
			SINGLE: "a$b",
			BARE: "overridden",
			MULTI: "a\nb",
			EMPTY: "",
			QUOTE: 'a"b',
			BACKTICK: "x y"
		})
	})
})

describe("guessScalar", () => {
	it.each([
		["true", true],
		["false", false],
		["1433", 1433],
		["-1.5", -1.5],
		["1.50", "1.50"],
		["007", "007"],
		["", ""],
		["1e3", "1e3"],
		["abc", "abc"]
	])("%j → %j", (value, expected) => {
		expect(guessScalar(value)).toBe(expected)
	})
})

describe("toTree", () => {
	const words = (name: string) => name.split("_")

	it("the first word is always an object; deeper levels only when shared", () => {
		const items: Array<[string[], string | number | boolean]> = [
			[words("DATABASE_SERVER"), "db"],
			[words("DATABASE_PORT"), 1433],
			[words("OAUTH2_CLIENT_ID"), "id"],
			[words("M3_DRY_RUN"), true],
			[words("NODE_ENV"), "development"],
			[words("VITE_API_URL"), "u"],
			[words("VITE_API_KEY"), "k"],
			[words("VITE_DEBUG"), true]
		]
		expect(toTree(items)).toEqual({
			database: { server: "db", port: 1433 },
			oauth2: { clientId: "id" },
			m3: { dryRun: true },
			node: { env: "development" },
			vite: { api: { url: "u", key: "k" }, debug: true }
		})
	})

	it("RESEND_TOKEN → resend.token", () => {
		expect(toTree([[words("RESEND_TOKEN"), "t"], [words("PORT"), 1]])).toEqual({ resend: { token: "t" }, port: 1 })
	})

	it("inside an existing object, falls back to the two-or-more rule", () => {
		expect(toTree([[words("POOL_MAX"), 1]], 1)).toEqual({ poolMax: 1 })
	})

	it("doesn't group when the prefix is also a variable on its own", () => {
		const items: Array<[string[], string]> = [
			[words("DATABASE"), "x"],
			[words("DATABASE_SERVER"), "a"],
			[words("DATABASE_NAME"), "b"]
		]
		expect(toTree(items)).toEqual({ database: "x", databaseServer: "a", databaseName: "b" })
	})

	it("uses the name as-is when camelCase can't reproduce it", () => {
		expect(toTree([[words("X_2FA"), "a"]])).toEqual({ X_2FA: "a" })
	})
})

describe("coerceLike", () => {
	it.each([
		["1434", 1433, 1434],
		["abc", 1433, "abc"],
		["false", true, false],
		["yes", true, "yes"],
		["1433", "x", "1433"]
	] as const)("%j like %j → %j", (raw, previous, expected) => {
		expect(coerceLike(raw, previous)).toBe(expected)
	})
})

describe("placeNew", () => {
	it("places new variables inside the deepest existing object", () => {
		const own = { database: { server: "a", pool: { min: 1 } }, debug: true }
		const added: Array<[string, string | number]> = [
			["DATABASE_NAME", "X"],
			["DATABASE_POOL_MAX", 10],
			["API_URL", "u"],
			["API_KEY", "k"],
			["TIMEOUT", 5]
		]
		expect(placeNew(own, added)).toEqual({
			database: { name: "X", pool: { max: 10 } },
			api: { url: "u", key: "k" },
			timeout: 5
		})
	})
})
