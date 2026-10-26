import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { main } from "../src/commands.ts"

let root: string
let project: string
let output: string[]
let errors: string[]

function writeConfig(extra = "") {
	const config = `export default {
	shared: { development: { backend: { database: { server: "db-dev", port: 1433 } } } },
	projects: {
		myapp: {
			path: ${JSON.stringify(project)},
			ports: { backend: 3791, frontend: 5791 },
			targets: {
				backend: { dir: "apps/backend", loader: "bun", accessor: true },
				frontend: { dir: "apps/frontend", loader: "vite" }
			},
			derive: (context) => ({
				backend: { backendPort: context.port.backend },
				frontend: { frontendPort: context.port.frontend, vite: { backendBaseUrl: "https://localhost:" + context.port.backend } }
			}),
			development: { backend: { database: { name: "MYAPP", password: "abc$defgh123" } } }
		}${extra}
	}
}
`
	writeFileSync(join(root, "config", "config.ts"), config, { mode: 0o600 })
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "dotgen-cli-"))
	project = join(root, "myapp")
	mkdirSync(join(project, "apps", "backend"), { recursive: true })
	mkdirSync(join(project, "apps", "frontend"), { recursive: true })
	spawnSync("git", ["init", "-q"], { cwd: project })
	writeFileSync(join(project, ".gitignore"), ".env.*\n")
	mkdirSync(join(root, "config"))
	vi.stubEnv("DOTGEN_CONFIG_DIR", join(root, "config"))
	writeConfig()
	output = []
	errors = []
	vi.spyOn(console, "log").mockImplementation((line: string) => void output.push(line))
	vi.spyOn(console, "error").mockImplementation((line: string) => void errors.push(line))
})

afterEach(() => {
	vi.restoreAllMocks()
	vi.unstubAllEnvs()
})

const read = (path: string) => readFileSync(join(project, path), "utf8")

describe("dotgen <project> <env>", () => {
	it("generates every target's files", async () => {
		expect(await main(["myapp", "development"])).toBe(0)

		const backend = read("apps/backend/.env.development")
		expect(backend).toContain('DATABASE_PASSWORD="abc\\$defgh123"')
		expect(backend).toContain('BACKEND_PORT="3791"')
		expect(statSync(join(project, "apps/backend/.env.development")).mode & 0o777).toBe(0o600)

		expect(read("apps/frontend/.env.development")).toContain('VITE_BACKEND_BASE_URL="https://localhost:3791"')
		expect(read("apps/backend/env.d.ts")).toContain("DATABASE_PASSWORD: string")
		expect(read("apps/backend/env.ts")).toContain("port: Number(Bun.env.DATABASE_PORT)")
		expect(existsSync(join(project, "apps/frontend/env.ts"))).toBe(false)

		expect(output[0]).toBe("myapp / development")
		expect(output.join("\n")).toContain("created")
		expect(errors).toEqual([])
	})

	it("changes nothing the second time", async () => {
		await main(["myapp", "development"])
		output = []
		await main(["myapp", "development"])
		expect(output.slice(1).every((line) => line.includes("unchanged"))).toBe(true)
	})

	it("--dry-run writes nothing and hides secrets", async () => {
		expect(await main(["myapp", "development", "--dry-run", "-v"])).toBe(0)
		expect(existsSync(join(project, "apps/backend/.env.development"))).toBe(false)
		const text = output.join("\n")
		expect(text).toContain("DATABASE_PASSWORD=set (12 chars)")
		expect(text).not.toContain("abc$defgh123")
	})

	it("doesn't overwrite a foreign file without --force, and writes none", async () => {
		writeFileSync(join(project, "apps/frontend/.env.development"), 'A="manual"\n')
		await expect(main(["myapp", "development"])).rejects.toThrow(/--force/)
		expect(existsSync(join(project, "apps/backend/.env.development"))).toBe(false)
		expect(await main(["myapp", "development", "--force"])).toBe(0)
	})

	it("warns when the file isn't in .gitignore", async () => {
		writeFileSync(join(project, ".gitignore"), "")
		await main(["myapp", "development"])
		expect(errors.some((line) => line.includes("isn't in .gitignore"))).toBe(true)
	})
})

describe("import", () => {
	const configFile = () => join(root, "config", "config.ts")
	const envFile = (base: string) => join(base, "apps", "backend", ".env.development")

	it("updates, adds, and skips what shared already covers, without touching the rest", async () => {
		writeFileSync(
			envFile(project),
			['DATABASE_SERVER="db-dev"', 'DATABASE_NAME="MYAPP"', 'DATABASE_PASSWORD="new$pass"', 'DATABASE_POOL="5"', 'API_URL="u"', 'API_KEY="k"'].join("\n")
		)
		const before = readFileSync(configFile(), "utf8")
		expect(await main(["import", envFile(project), "--verbose"])).toBe(0)

		const text = output.join("\n")
		expect(text).toContain("myapp / development / backend")
		expect(text).toContain("3 added, 1 changed, 1 unchanged, 1 already covered by shared/derive")
		expect(text).toContain("~ DATABASE_PASSWORD: set (12 chars) → set (8 chars)")
		expect(text).not.toContain("new$pass")

		const after = readFileSync(configFile(), "utf8")
		// The object was on one line, so the new keys are too.
		expect(after).toContain('development: { backend: { database: { name: "MYAPP", password: "new$pass", pool: 5 }, api: { url: "u", key: "k" } } }')
		expect(after).toContain("derive: (context) => ({")
		expect(readFileSync(`${configFile()}.bak`, "utf8")).toBe(before)
		expect(statSync(configFile()).mode & 0o777).toBe(0o600)

		// The edited config still generates.
		output = []
		expect(await main(["myapp", "development", "--force"])).toBe(0)
	})

	it("creates the project and target if they don't exist", async () => {
		const wms = join(root, "wms")
		mkdirSync(join(wms, "apps", "backend"), { recursive: true })
		spawnSync("git", ["init", "-q"], { cwd: wms })
		writeFileSync(join(wms, "bun.lock"), "")
		writeFileSync(envFile(wms), 'DATABASE_SERVER="x"\nDATABASE_PORT="1433"\n')

		expect(await main(["import", envFile(wms)])).toBe(0)
		const text = output.join("\n")
		expect(text).toContain("+ project wms")
		expect(text).toContain("+ target backend (dir apps/backend, loader bun")
		expect(errors.join("\n")).toContain("wms has no `ports`")

		const after = readFileSync(configFile(), "utf8")
		expect(after).toContain("wms: {")
		expect(after).toContain("port: 1433")
		output = []
		expect(await main(["wms", "development", "--force"])).toBe(0)
	})

	it("--dry-run writes nothing", async () => {
		writeFileSync(envFile(project), 'NEW_VALUE="1"\n')
		const before = readFileSync(configFile(), "utf8")
		expect(await main(["import", envFile(project), "--dry-run", "-v"])).toBe(0)
		expect(output.join("\n")).toContain('+ NEW_VALUE="1"')
		expect(readFileSync(configFile(), "utf8")).toBe(before)
	})

	it("shows only the summary without --verbose", async () => {
		writeFileSync(envFile(project), 'NEW_VALUE="1"\nDATABASE_PASSWORD="otra"\n')
		expect(await main(["import", envFile(project), "--dry-run"])).toBe(0)
		const text = output.join("\n")
		expect(text).toContain("1 added, 1 changed")
		expect(text).not.toContain("NEW_VALUE")
		expect(text).not.toContain("DATABASE_PASSWORD")
	})

	it("accepts an explicit environment in either order", async () => {
		const file = join(project, "apps", "backend", "legacy")
		writeFileSync(file, 'NEW_VALUE="1"\n')
		expect(await main(["import", "staging", file, "--dry-run"])).toBe(0)
		expect(output[0]).toBe("myapp / staging / backend (dry-run: nothing was written)")
		await expect(main(["import", file])).rejects.toThrow(/Couldn't infer the environment/)
	})

	it("restores the previous config if the edited one doesn't load", async () => {
		const { applyImport } = await import("../src/import.ts")
		const before = readFileSync(configFile(), "utf8")
		const plan = { project: "myapp", env: "development", target: "backend", changes: [], source: "export default {" }
		await expect(applyImport([plan], configFile())).rejects.toThrow(/the previous one was restored/)
		expect(readFileSync(configFile(), "utf8")).toBe(before)
	})

	it("with a folder, discovers targets and environments and writes once", async () => {
		const wms = join(root, "wms")
		for (const dir of ["apps/backend", "apps/frontend", "node_modules/pkg", ".cache"]) mkdirSync(join(wms, dir), { recursive: true })
		spawnSync("git", ["init", "-q"], { cwd: wms })
		writeFileSync(join(wms, "bun.lock"), "")
		writeFileSync(join(wms, "apps/frontend/vite.config.ts"), "export default {}\n")
		writeFileSync(join(wms, "apps/frontend/index.html"), "<div id=app></div>\n")
		// A backend with vite.config.ts just for vitest is still bun.
		writeFileSync(join(wms, "apps/backend/vite.config.ts"), "export default {}\n")
		writeFileSync(join(wms, "apps/backend/.env.development"), 'DATABASE_NAME="WMS"\nDATABASE_PASSWORD="p$ss"\n')
		writeFileSync(join(wms, "apps/backend/.env.production"), 'DATABASE_NAME="WMS_PRD"\n')
		writeFileSync(join(wms, "apps/frontend/.env.development"), 'VITE_API_URL="https://localhost:3000"\nFRONTEND_PORT="5173"\n')
		writeFileSync(join(wms, "apps/backend/.env.example"), 'DATABASE_NAME=""\n')
		writeFileSync(join(wms, "apps/backend/.env.local"), 'X="1"\n')
		writeFileSync(join(wms, "node_modules/pkg/.env.development"), 'IGNORED="1"\n')
		writeFileSync(join(wms, ".cache/.env.development"), 'IGNORED="1"\n')

		expect(await main(["import", wms, "-v"])).toBe(0)
		const text = output.join("\n")
		expect(text).toContain("skipped apps/backend/.env.example")
		expect(text).toContain("skipped apps/backend/.env.local")
		expect(text).toContain("wms / development / backend")
		expect(text).toContain("wms / production / backend")
		expect(text).toContain("wms / development / frontend")
		expect(text).toContain("+ target frontend (dir apps/frontend, loader vite")
		expect(text).toContain("+ target backend (dir apps/backend, loader bun")
		expect(text).not.toContain("IGNORED")
		expect(text.match(/\+ project wms/g)).toHaveLength(1)
		expect(text.match(/Saved to/g)).toHaveLength(1)

		output = []
		expect(await main(["wms", "development", "--force"])).toBe(0)
		expect(await main(["wms", "production", "--force"])).toBe(0)

		// A second pass changes nothing.
		const before = readFileSync(configFile(), "utf8")
		output = []
		expect(await main(["import", wms])).toBe(0)
		expect(output.join("\n")).not.toContain("Saved to")
		expect(readFileSync(configFile(), "utf8")).toBe(before)
	})

	it("with a folder and an environment, imports only that one", async () => {
		const wms = join(root, "wms")
		mkdirSync(join(wms, "api"), { recursive: true })
		writeFileSync(join(wms, "api/.env.development"), 'A="1"\n')
		writeFileSync(join(wms, "api/.env.production"), 'A="2"\n')
		expect(await main(["import", wms, "production", "--dry-run"])).toBe(0)
		const text = output.join("\n")
		expect(text).toContain("wms / production / api")
		expect(text).not.toContain("wms / development")
	})
})

describe("share", () => {
	function twoProjects() {
		const other = join(root, "other")
		mkdirSync(join(other, "apps", "backend"), { recursive: true })
		writeConfig(`,
		other: {
			path: ${JSON.stringify(other)},
			targets: { backend: { dir: "apps/backend", loader: "bun" } },
			development: { backend: { database: { name: "MYAPP", password: "abc$defgh123" }, resend: { token: "r" } } }
		}`)
	}

	it("says so when nothing is repeated", async () => {
		expect(await main(["share"], { choose: async () => [] })).toBe(0)
		expect(output).toContain("No values are repeated across projects.")
	})

	it("moves the picked ones, marks the rest local, and doesn't change what each project receives", async () => {
		twoProjects()
		const asked: string[][] = []
		const choose = async (message: string, options: Array<{ value: string; label: string }>) => {
			asked.push(options.map((option) => option.label))
			return message.startsWith("Which ones should move") ? ["development:backend.database.password"] : ["backend.database.name"]
		}
		expect(await main(["share"], { choose })).toBe(0)
		// Without --verbose there are no values, not even masked.
		expect(asked[0]).toEqual(["development · backend.database.name", "development · backend.database.password"])
		expect(asked[1]).toEqual(["backend.database.name"])
		expect(output.join("\n")).toContain("→ shared  development · backend.database.password")
		expect(output.join("\n")).toContain("→ local   backend.database.name")

		const after = readFileSync(join(root, "config", "config.ts"), "utf8")
		expect(after).toContain('local: ["backend.database.name"]')
		expect(after.match(/abc\$defgh123/g)).toHaveLength(1)

		// Nothing is suggested anymore, and generation stays the same.
		output = []
		expect(await main(["share"], { choose: async () => [] })).toBe(0)
		expect(output).toContain("No values are repeated across projects.")
		expect(await main(["myapp", "development"])).toBe(0)
		expect(read("apps/backend/.env.development")).toContain('DATABASE_PASSWORD="abc\\$defgh123"')
	})

	it("--dry-run lists without writing, and check warns", async () => {
		twoProjects()
		const before = readFileSync(join(root, "config", "config.ts"), "utf8")
		expect(await main(["share", "--dry-run"])).toBe(0)
		expect(output.join("\n")).toContain("same in: myapp, other")
		expect(readFileSync(join(root, "config", "config.ts"), "utf8")).toBe(before)
		await main(["check"])
		expect(errors.join("\n")).toContain("2 value(s) repeated")
	})

	it("without a terminal, lists only paths; with -v, masked values", async () => {
		twoProjects()
		expect(await main(["share"], { choose: async () => undefined })).toBe(1)
		const plain = output.join("\n")
		expect(plain).toContain("development · backend.database.password")
		expect(plain).not.toContain("MYAPP")
		expect(plain).not.toContain("chars")

		output = []
		await main(["share", "--dry-run", "-v"])
		const verbose = output.join("\n")
		expect(verbose).toContain('backend.database.name = "MYAPP"')
		expect(verbose).toContain("backend.database.password = set (12 chars)")
		expect(verbose).not.toContain("abc$defgh123")
	})

	it("with flags: --only, --yes --skip, --local, and prefixes", async () => {
		twoProjects()
		const file = join(root, "config", "config.ts")
		const before = readFileSync(file, "utf8")

		await main(["share", "--yes", "--skip", "backend.database.name", "--local", "backend.database.name", "--dry-run"])
		expect(output).toContain("  → shared  development · backend.database.password")
		expect(output).toContain("  → local   backend.database.name")
		expect(output.join("\n")).not.toContain("→ shared  development · backend.database.name")
		expect(readFileSync(file, "utf8")).toBe(before)

		output = []
		await main(["share", "--only", "backend.database", "--dry-run"])
		expect(output.filter((line) => line.includes("→ shared"))).toHaveLength(2)

		await expect(main(["share", "--skip", "x"])).rejects.toThrow(/--skip goes with --yes/)
		await expect(main(["share", "--only", "backend.nothing"])).rejects.toThrow("No repeated values match: backend.nothing.")
		await expect(main(["share", "--only", "backend.database", "--local", "backend.database.name"])).rejects.toThrow(/at the same time/)

		expect(await main(["share", "--only", "backend.database.password", "--local", "backend.database.name"])).toBe(0)
		const after = readFileSync(file, "utf8")
		expect(after).toContain('local: ["backend.database.name"]')
		expect(after.match(/abc\$defgh123/g)).toHaveLength(1)
	})

	it("cancelling changes nothing", async () => {
		twoProjects()
		const before = readFileSync(join(root, "config", "config.ts"), "utf8")
		await main(["share"], { choose: async () => undefined })
		expect(readFileSync(join(root, "config", "config.ts"), "utf8")).toBe(before)
	})
})

describe("other commands", () => {
	it("<env> detects the project from cwd", async () => {
		vi.spyOn(process, "cwd").mockReturnValue(join(project, "apps", "backend"))
		expect(await main(["development"])).toBe(0)
		expect(output[0]).toBe("myapp / development")
	})

	it("all generates every project with that environment", async () => {
		expect(await main(["all", "development"])).toBe(0)
		expect(output).toContain("myapp / development")
	})

	it("check detects missing typed files, then passes", async () => {
		expect(await main(["check"])).toBe(1)
		expect(errors.join("\n")).toMatch(/env\.d\.ts doesn't exist/)
		await main(["myapp", "development"])
		errors = []
		expect(await main(["check"])).toBe(0)
		expect(errors).toEqual([])
	})

	it("ports flags collisions", async () => {
		writeConfig(`, other: { path: ${JSON.stringify(project)}, ports: { api: 5791 }, targets: {} }`)
		expect(await main(["ports"])).toBe(1)
		expect(output.join("\n")).toContain("✗ collides with")
	})


	it("warns when the config doesn't have 600 permissions", async () => {
		writeFileSync(join(root, "config", "config.ts"), readFileSync(join(root, "config", "config.ts")), { mode: 0o644 })
		spawnSync("chmod", ["644", join(root, "config", "config.ts")])
		await main(["ports"])
		expect(errors.some((line) => line.includes("permissions 644"))).toBe(true)
	})

	it("ports <project> registers ports and rejects collisions", async () => {
		const file = join(root, "config", "config.ts")
		writeConfig(`, other: { path: ${JSON.stringify(project)}, targets: {} }`)
		await expect(main(["ports", "other", "api=5791"])).rejects.toThrow("Port 5791 repeated: projects.myapp.ports.frontend and projects.other.ports.api.")
		await expect(main(["ports", "other", "api=abc"])).rejects.toThrow(/isn't a <seed> or <target>=<port>/)

		const before = readFileSync(file, "utf8")
		expect(await main(["ports", "other", "api=4000", "--dry-run"])).toBe(0)
		expect(readFileSync(file, "utf8")).toBe(before)

		expect(await main(["ports", "other", "api=4000"])).toBe(0)
		expect(await main(["ports", "myapp", "backend=3800"])).toBe(0)
		expect(output.join("\n")).toContain("myapp.backend: 3791 → 3800")
		const after = readFileSync(file, "utf8")
		expect(after).toContain("ports: { backend: 3800, frontend: 5791 }")
		expect(after).toContain("api: 4000")
	})

	it("ports <project> <seed>: backend +1, frontend +2, and collisions between seeds", async () => {
		const file = join(root, "config", "config.ts")
		const other = join(root, "other")
		mkdirSync(join(other, "apps", "backend"), { recursive: true })
		writeConfig(`, other: { path: ${JSON.stringify(other)}, targets: { backend: { dir: "apps/backend", loader: "bun" } }, development: {} }`)
		// myapp has explicit ports (3791/5791); remove them by hand so the seed takes over.
		writeFileSync(file, readFileSync(file, "utf8").replace("ports: { backend: 3791, frontend: 5791 },", ""))

		expect(await main(["ports", "myapp", "5010"])).toBe(0)
		expect(output).toContain("  myapp.backend: new → 5011")
		expect(output).toContain("  myapp.frontend: new → 5012")
		expect(readFileSync(file, "utf8")).toContain("seed: 5010")

		await expect(main(["ports", "other", "5011"])).rejects.toThrow(
			"Port 5012 repeated: projects.myapp.seed + 2 (frontend) and projects.other.seed + 1 (backend)."
		)
		expect(await main(["ports", "other", "5020"])).toBe(0)

		output = []
		expect(await main(["ports"])).toBe(0)
		expect(output.join("\n")).toMatch(/5011\s+myapp\s+backend\s+seed 5010 \+ 1/)
		expect(output.join("\n")).toMatch(/5022\s+other\s+frontend\s+seed 5020 \+ 2/)

		// derive sees the computed ports, and an explicit port wins over the seed.
		expect(await main(["ports", "myapp", "backend=5015"])).toBe(0)
		await main(["myapp", "development", "--force"])
		expect(read("apps/backend/.env.development")).toContain('BACKEND_PORT="5015"')
		expect(read("apps/frontend/.env.development")).toContain('FRONTEND_PORT="5012"')
	})

	it("shows usage without arguments", async () => {
		expect(await main([])).toBe(1)
		expect(output[0]).toMatch(/^Usage:/)
	})
})
