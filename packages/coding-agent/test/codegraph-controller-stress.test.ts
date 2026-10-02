import { type ChildProcess, fork } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireCodegraph } from "../src/core/codegraph/controller.ts";
import type { CodegraphService, CodegraphStatus } from "../src/core/codegraph/types.ts";

const roots: string[] = [];
const services: CodegraphService[] = [];
const children: ChildProcess[] = [];

function project(): string {
	const root = mkdtempSync(join(tmpdir(), "pi-codegraph-stress-"));
	roots.push(root);
	mkdirSync(join(root, "src"));
	writeFileSync(
		join(root, "src", "entry.js"),
		"export function jsEntry() { return jsHelper(); }\nexport function jsHelper() { return 1; }\n",
	);
	writeFileSync(join(root, "src", "entry.ts"), "export function tsEntry() { return 2; }\n");
	writeFileSync(join(root, "src", "entry.py"), "def python_entry():\n    return 3\n");
	return root;
}

function acquire(root: string): CodegraphService {
	const service = acquireCodegraph({ cwd: root, grant: { root }, settings: { watch: true, debounceMs: 100 } });
	services.push(service);
	return service;
}

async function settled(service: CodegraphService): Promise<CodegraphStatus> {
	const deadline = Date.now() + 30_000;
	while (Date.now() < deadline) {
		const status = service.status();
		if (["ready", "error", "degraded"].includes(status.state)) return status;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error(`CodeGraph did not settle: ${JSON.stringify(service.status())}`);
}

async function dispose(service: CodegraphService): Promise<void> {
	service.dispose();
	await service.disposed;
}

async function stopChild(child: ChildProcess): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return;
	await new Promise<void>((resolve) => {
		const deadline = setTimeout(() => child.kill("SIGKILL"), 8_000);
		child.once("exit", () => {
			clearTimeout(deadline);
			resolve();
		});
		if (child.connected) child.send({ type: "shutdown" });
		else child.kill("SIGTERM");
	});
}

afterEach(async () => {
	for (const service of services.splice(0)) await dispose(service);
	for (const child of children.splice(0)) await stopChild(child);
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("CodeGraph real-library lifecycle stress", () => {
	it("indexes JavaScript call edges alongside TypeScript and Python", async () => {
		const service = acquire(project());
		expect(await settled(service)).toMatchObject({ state: "ready", partial: false });
		const result = await service.query({ operation: "callees", name: "jsEntry" });
		expect(result).toMatchObject({
			status: "ok",
			subject: { name: "jsEntry", file: "src/entry.js", kind: "function" },
		});
		expect(result.nodes).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ name: "jsHelper", language: "javascript", file: "src/entry.js" }),
			]),
		);
		expect(result.edges.some((edge) => edge.kind === "calls")).toBe(true);
		expect(
			(await service.query({ operation: "search", query: "tsEntry" })).nodes.some(
				(node) => node.language === "typescript",
			),
		).toBe(true);
		expect(
			(await service.query({ operation: "search", query: "python_entry" })).nodes.some(
				(node) => node.language === "python",
			),
		).toBe(true);
	});

	it.each(["callers", "callees", "impact", "context"] as const)("honors depth zero for %s", async (operation) => {
		const service = acquire(project());
		expect((await settled(service)).state).toBe("ready");
		const name = operation === "callers" || operation === "impact" ? "jsHelper" : "jsEntry";
		const result = await service.query({ operation, name, depth: 0 });
		expect(result.status).toBe("ok");
		expect(result.limits.depth).toBe(0);
		expect(result.edges).toEqual([]);
		if (operation === "context" || operation === "impact")
			expect(result.nodes.map((node) => node.name)).toEqual([name]);
		else {
			expect(result.nodes).toEqual([]);
			expect(result).toMatchObject({ subject: { name, kind: "function", file: "src/entry.js" } });
		}
	});

	it("identifies the effective dependency direction in results", async () => {
		const root = project();
		writeFileSync(
			join(root, "src", "importer.ts"),
			"import { jsEntry } from './entry.js';\nexport function importedEntry() { return jsEntry(); }\n",
		);
		const service = acquire(root);
		expect((await settled(service)).state).toBe("ready");
		const imports = await service.query({ operation: "dependencies", file: "src/importer.ts" });
		expect(imports).toMatchObject({
			status: "ok",
			direction: "imports",
			files: ["src/entry.js"],
			subject: { kind: "file", file: "src/importer.ts" },
		});
		const dependents = await service.query({
			operation: "dependencies",
			file: "src/entry.js",
			direction: "dependents",
		});
		expect(dependents).toMatchObject({
			status: "ok",
			direction: "dependents",
			files: ["src/importer.ts"],
			subject: { kind: "file", file: "src/entry.js" },
		});
		for (const file of ["src/missing.ts", ".env", "unsupported.txt"]) {
			const absent = await service.query({ operation: "dependencies", file });
			expect(absent).toMatchObject({ status: "not_found", nodes: [], files: [], edges: [] });
			expect(absent).not.toHaveProperty("subject");
		}
	});

	it("cancels one owner's queued query without stopping a shared index", async () => {
		const root = project();
		const first = acquire(root);
		const second = acquire(root);
		expect((await settled(first)).state).toBe("ready");
		const abort = new AbortController();
		const cancelled = first.query(
			{ operation: "context", query: "jsEntry jsHelper", includeCode: true },
			abort.signal,
		);
		abort.abort();
		expect((await cancelled).status).toBe("cancelled");
		expect((await second.query({ operation: "search", query: "jsEntry" })).status).toBe("ok");
		await dispose(first);
		expect(second.status().state).toBe("ready");
	});

	it("reports pending watcher changes before the debounce window expires", async () => {
		const root = project();
		const service = acquireCodegraph({ cwd: root, grant: { root }, settings: { watch: true, debounceMs: 5_000 } });
		services.push(service);
		expect(await settled(service)).toMatchObject({ state: "ready", watcher: "healthy", freshness: "current" });
		writeFileSync(join(root, "src", "entry.js"), "export function jsChanged() { return 4; }\n");
		const deadline = Date.now() + 2_000;
		while (service.status().pendingChanges === 0 && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		expect(
			service.status(),
			"on-demand status must not claim current while watcher events await debounce",
		).toMatchObject({
			state: "ready",
			freshness: "stale",
			activeOperation: null,
		});
		expect(service.status().pendingChanges).toBeGreaterThan(0);
	});

	it("invalidates initial-index requests and drains when last owner immediately exits", async () => {
		const root = project();
		const service = acquire(root);
		const pending = service.query({ operation: "search", query: "jsEntry" });
		service.dispose();
		await service.disposed;
		expect(["not_ready", "cancelled"]).toContain((await pending).status);
		expect((await service.query({ operation: "search", query: "jsEntry" })).status).toBe("cancelled");
		const replacement = acquire(root);
		expect((await settled(replacement)).state).toBe("ready");
	});

	it("fails boundedly under a real write lock held by another Pi process and recovers after release", async () => {
		const root = project();
		const helperDirectory = mkdtempSync(join(tmpdir(), "pi-codegraph-owner-helper-"));
		roots.push(helperDirectory);
		const script = join(helperDirectory, "owner.mjs");
		const controllerUrl = new URL("../src/core/codegraph/controller.ts", import.meta.url).href;
		const libraryUrl = new URL("../../../node_modules/@colbymchenry/codegraph/npm-sdk.js", import.meta.url).href;
		writeFileSync(
			script,
			`import { acquireCodegraph } from ${JSON.stringify(controllerUrl)};
import codegraph from ${JSON.stringify(libraryUrl)};
const root = process.argv[2];
process.umask(0o077);
const service = acquireCodegraph({cwd: root, grant: {root}, settings: {watch: true, debounceMs: 100}});
let stopping = false;
let lock;
process.on("message", async (message) => {
  if (message.type !== "shutdown" || stopping) return;
  stopping = true;
  lock?.release();
  service.dispose();
  await service.disposed;
  process.disconnect();
});
const deadline = Date.now() + 30000;
while (!stopping && !["ready", "error", "degraded"].includes(service.status().state)) {
  if (Date.now() >= deadline) throw new Error(JSON.stringify(service.status()));
  await new Promise(resolve => setTimeout(resolve, 20));
}
if (!stopping) {
  if (service.status().state === "ready") {
    lock = new codegraph.FileLock(root + "/.codegraph/codegraph.lock");
    lock.acquire();
  }
  process.send(service.status());
}
`,
		);
		const child = fork(script, [root], {
			execArgv: [],
			env: { PATH: process.env.PATH, HOME: process.env.HOME },
			stdio: ["ignore", "pipe", "pipe", "ipc"],
		});
		children.push(child);
		let diagnostics = "";
		child.stdout?.on("data", (data: Buffer) => {
			diagnostics += data.toString();
		});
		child.stderr?.on("data", (data: Buffer) => {
			diagnostics += data.toString();
		});
		const status = await new Promise<unknown>((resolve, reject) => {
			const deadline = setTimeout(
				() => reject(new Error(`Other Pi process startup timed out: ${diagnostics}`)),
				35_000,
			);
			child.once("message", (message) => {
				clearTimeout(deadline);
				resolve(message);
			});
			child.once("error", (error) => {
				clearTimeout(deadline);
				reject(error);
			});
			child.once("exit", (code) => {
				clearTimeout(deadline);
				reject(new Error(`Other Pi process exited ${code}: ${diagnostics}`));
			});
		});
		expect(status, diagnostics).toMatchObject({ state: "ready" });
		const contender = acquire(root);
		const contention = await settled(contender);
		expect(["error", "degraded"]).toContain(contention.state);
		expect(contention.lastError).toMatch(/lock|another process|already/i);
		expect((await contender.query({ operation: "search", query: "jsEntry" })).status).toBe("error");
		await dispose(contender);
		await stopChild(child);
		const recovered = acquire(root);
		expect((await settled(recovered)).state).toBe("ready");
		expect(
			(await recovered.query({ operation: "search", query: "jsEntry" })).nodes.some(
				(node) => node.name === "jsEntry",
			),
		).toBe(true);
	}, 60_000);

	it.skipIf(process.platform !== "linux")(
		"releases workers and keeps descriptor counts stable over repeated ownership cycles",
		async () => {
			const root = project();
			const samples: number[] = [];
			for (let cycle = 0; cycle < 5; cycle++) {
				const first = acquire(root);
				const second = acquire(root);
				expect((await settled(first)).state).toBe("ready");
				await first.refresh();
				await dispose(first);
				await dispose(second);
				const childPath = `/proc/self/task/${process.pid}/children`;
				expect(readFileSync(childPath, "utf8").trim()).toBe("");
				expect(existsSync(join(root, ".codegraph", "codegraph.db"))).toBe(true);
				samples.push(readdirSync("/proc/self/fd").length);
			}
			expect(Math.max(...samples) - Math.min(...samples), JSON.stringify(samples)).toBeLessThanOrEqual(1);
		},
		60_000,
	);
});
