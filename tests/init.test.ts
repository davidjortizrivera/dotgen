import { describe, expect, it } from "vitest"
import { configObject, findProperty, parseSource } from "../src/edit.ts"
import { exampleConfig } from "../src/init.ts"

describe("exampleConfig", () => {
	it("has no live data that would mix with real projects", () => {
		const object = configObject(parseSource(exampleConfig("dotgen")))
		for (const key of ["shared", "projects"]) {
			const value = findProperty(object, key)?.value
			expect(value?.type).toBe("ObjectExpression")
			expect(value?.type === "ObjectExpression" && value.properties).toHaveLength(0)
		}
	})
})
