import { describe, expect, it } from "vitest"
import { escapeValue } from "../src/escape.ts"

describe("escapeValue", () => {
	it.each([
		["bun", "abc$defgh123", '"abc\\$defgh123"'],
		["vite", "abc$defgh123", '"abc\\$defgh123"'],
		["node", "abc$defgh123", '"abc$defgh123"'],
		["bun", "x${REF}y", '"x\\${REF}y"'],
		["node", "x${REF}y", '"x${REF}y"'],
		["bun", "a#b", '"a#b"'],
		["vite", "a'b", '"a\'b"'],
		["node", "a\\b", '"a\\b"'],
		["bun", "a\\\\b", '"a\\\\b"'],
		["vite", "a\nb", '"a\\nb"'],
		["node", "a\\$b", '"a\\$b"']
	] as const)("%s: %j → %s", (loader, value, expected) => {
		expect(escapeValue("X", value, loader)).toBe(expected)
	})

	it("writes numbers and booleans as text", () => {
		expect(escapeValue("PORT", 1433, "bun")).toBe('"1433"')
		expect(escapeValue("DRY_RUN", true, "vite")).toBe('"true"')
	})

	it.each([
		["bun", 'a"b', /double quotes/],
		["node", "a\tb", /control characters/],
		["vite", "a\rb", /control characters/],
		["node", "a\\nb", /followed by "n"/],
		["bun", "ab\\", /ends with/],
		["vite", "a\\$b", /before `\$`/],
		["bun", "a\\$b", /before `\$`/]
	] as const)("%s rejects %j", (loader, value, message) => {
		expect(() => escapeValue("DATABASE_PASSWORD", value, loader)).toThrow(message)
	})

	it("never shows the value in the error", () => {
		expect(() => escapeValue("DATABASE_PASSWORD", 'secr"et', "bun")).toThrow(/^DATABASE_PASSWORD: the value contains/)
		try {
			escapeValue("DATABASE_PASSWORD", 'secr"et', "bun")
		} catch (error) {
			expect((error as Error).message).not.toContain("secr")
		}
	})
})
