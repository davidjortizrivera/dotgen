import { defineConfig } from "../src/index.ts"

// @ts-expect-error: an environment with an array doesn't compile
defineConfig({ projects: { a: { path: "/a", targets: {}, development: { backend: { list: [1] } } } } })

// @ts-expect-error: path must be a string
defineConfig({ projects: { a: { path: 1, targets: {} } } })

defineConfig({
	projects: {
		a: {
			path: "/a",
			targets: { web: { dir: ".", loader: "vite" } },
			derive: (context) => {
				const port: number | undefined = context.port.web
				return { web: { port: port ?? 0 } }
			},
			development: { web: { vite: { url: "x", n: 1, ok: true } } }
		}
	}
})
