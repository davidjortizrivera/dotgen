import { describe, expect, it } from "vitest"
import { merge, mergeTargets } from "../src/merge.ts"
import type { Tree } from "../src/types.ts"

describe("merge", () => {
	it("merges objects and overwrites scalar values", () => {
		const base: Tree = { database: { server: "a", port: 1433 }, debug: false }
		const over: Tree = { database: { server: "b", name: "X" }, debug: true }
		expect(merge(base, over)).toEqual({ database: { server: "b", port: 1433, name: "X" }, debug: true })
	})

	it("allows changing the type of a scalar value", () => {
		expect(merge({ port: 1 }, { port: "2" })).toEqual({ port: "2" })
	})

	it("does not mutate its inputs", () => {
		const base: Tree = { database: { server: "a" } }
		const over: Tree = { database: { name: "X" } }
		const result = merge(base, over)
		;(result.database as Tree).server = "z"
		expect(base).toEqual({ database: { server: "a" } })
		expect(over).toEqual({ database: { name: "X" } })
	})

	it("fails on a scalar against an object, in both directions", () => {
		expect(() => merge({ database: "x" }, { database: { name: "y" } }, ["backend"])).toThrow(
			"backend.database: a scalar value collides with an object when merging layers."
		)
		expect(() => merge({ a: { b: { c: 1 } } }, { a: { b: 2 } })).toThrow("a.b: a scalar value")
	})
})

describe("mergeTargets", () => {
	it("applies layers in order and skips missing ones", () => {
		const result = mergeTargets([{ backend: { a: 1 } }, undefined, { backend: { a: 2 }, frontend: { b: 1 } }])
		expect(result).toEqual({ backend: { a: 2 }, frontend: { b: 1 } })
	})

	it("includes the target in the error path", () => {
		expect(() => mergeTargets([{ backend: { db: "x" } }, { backend: { db: { name: "y" } } }])).toThrow("backend.db:")
	})
})
