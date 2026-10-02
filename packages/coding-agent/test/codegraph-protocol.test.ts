import { existsSync, readFileSync, watch } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { acquireCodegraph } from "../src/core/codegraph/controller.ts";
import type { CodegraphService } from "../src/core/codegraph/types.ts";

const worker = vi.hoisted(() => ({ path: undefined as string | undefined }));
vi.mock("../src/config.ts", () => ({ getCodegraphWorkerSpecifier: () => worker.path }));
const services: CodegraphService[] = [];
const roots: string[] = [];

async function fixture(
	stalled = false,
	shutdownMs = 0,
	behavior: "crash-on-query" | "missing-asset" | "missing-platform" | undefined = undefined,
): Promise<CodegraphService> {
	const root = await mkdtemp(join(tmpdir(), "pi-codegraph-protocol-"));
	roots.push(root);
	worker.path =
		stalled || behavior === "crash-on-query" || behavior === "missing-platform"
			? join(root, "worker.mjs")
			: undefined;
	if (behavior === "missing-asset") worker.path = join(root, "missing-worker.mjs");
	if (behavior === "missing-platform") {
		await writeFile(worker.path!, await readFile(new URL("../src/core/codegraph/worker.mjs", import.meta.url)));
	}
	if (worker.path && behavior !== "missing-asset" && behavior !== "missing-platform") {
		await writeFile(
			worker.path,
			`import { writeFileSync } from "node:fs";
process.send({type: "status", status: {state: "ready", freshness: "current", partial: false}});
process.send({type: "ready"});
process.on("message", (message) => {
  if (message.type === "query") {
    writeFileSync(${JSON.stringify(join(root, "query.received"))}, "received");
    if (${behavior === "crash-on-query"}) process.exit(23);
  }
  if (message.type === "refresh") writeFileSync(${JSON.stringify(join(root, "refresh.received"))}, "received");
  if (message.type === "shutdown") setTimeout(() => process.disconnect(), ${shutdownMs});
});
`,
		);
	}
	const service = acquireCodegraph({ cwd: root, grant: { root } });
	services.push(service);
	if (stalled || behavior === "crash-on-query") {
		const deadline = Date.now() + 5000;
		while (service.status().state !== "ready") {
			if (Date.now() >= deadline) throw new Error(`Fake child startup failed: ${JSON.stringify(service.status())}`);
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
	}
	return service;
}

async function waitForWorkerMessage(root: string, type: "query" | "refresh"): Promise<void> {
	const marker = join(root, `${type}.received`);
	if (existsSync(marker)) return;
	await new Promise<void>((resolve) => {
		const watcher = watch(root, (_event, filename) => {
			if (filename?.toString() !== `${type}.received`) return;
			watcher.close();
			resolve();
		});
		if (existsSync(marker)) {
			watcher.close();
			resolve();
		}
	});
}

async function waitForState(service: CodegraphService, terminal: string[]): Promise<void> {
	const deadline = Date.now() + 5000;
	while (Date.now() < deadline) {
		if (terminal.includes(service.status().state)) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`Worker did not settle: ${JSON.stringify(service.status())}`);
}

function processState(pid: number): string | undefined {
	try {
		return /State:\s+(\S)/.exec(readFileSync(`/proc/${pid}/status`, "utf8"))?.[1];
	} catch {
		return undefined;
	}
}

function isDirectChild(pid: number): boolean {
	return readFileSync(`/proc/${process.pid}/task/${process.pid}/children`, "utf8")
		.trim()
		.split(/\s+/)
		.includes(String(pid));
}

afterEach(async () => {
	vi.useRealTimers();
	for (const service of services.splice(0)) {
		service.dispose();
		await service.disposed;
	}
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
	worker.path = undefined;
});

describe("CodeGraph private IPC lifecycle", () => {
	it("returns unavailable refresh immediately when worker asset cannot be resolved", async () => {
		const service = await fixture();
		const outcome = await service.refresh();
		expect(outcome.state).toBe("disabled");
		expect(outcome.reason).toContain("unavailable");
	});

	it("settles a pending request when the worker crashes", async () => {
		const service = await fixture(false, 0, "crash-on-query");
		const result = await service.query({ operation: "search", query: "entry" });
		expect(result.status).toBe("error");
		await waitForState(service, ["degraded", "error"]);
		service.dispose();
		await service.disposed;
		expect(service.status().state).toBe("disposed");
	});

	it("settles and drains when the worker entry asset is missing", async () => {
		const service = await fixture(false, 0, "missing-asset");
		await waitForState(service, ["degraded", "error"]);
		service.dispose();
		await Promise.race([
			service.disposed,
			new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Missing worker did not drain")), 2000)),
		]);
		expect(service.status().state).toBe("disposed");
	});

	it("reports a missing platform bundle from the real worker without hanging", async () => {
		const service = await fixture(false, 0, "missing-platform");
		await waitForState(service, ["degraded", "error"]);
		expect(service.status().lastError).toContain(`@colbymchenry/codegraph-${process.platform}-${process.arch}`);
		service.dispose();
		await service.disposed;
	});

	it.skipIf(process.platform !== "linux")(
		"force-kills a child that ignores the startup-timeout signal",
		async () => {
			const root = await mkdtemp(join(tmpdir(), "pi-codegraph-startup-timeout-"));
			roots.push(root);
			worker.path = join(root, "unresponsive.mjs");
			const pidPath = join(root, "worker.pid");
			await writeFile(
				worker.path,
				`import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));
process.on("SIGTERM", () => {});
`,
			);
			let resolvePid!: (pid: number) => void;
			const pidReady = new Promise<number>((resolve) => {
				resolvePid = resolve;
			});
			const watcher = watch(root, (_event, filename) => {
				if (filename?.toString() === "worker.pid") {
					watcher.close();
					resolvePid(Number(readFileSync(pidPath, "utf8")));
				}
			});
			vi.useFakeTimers();
			const service = acquireCodegraph({ cwd: root, grant: { root } });
			services.push(service);
			const pid = await pidReady;
			try {
				await vi.advanceTimersByTimeAsync(65_000);
				expect(service.status().state).toBe("error");
				vi.useRealTimers();
				const deadline = Date.now() + 2000;
				while (processState(pid) && processState(pid) !== "Z" && Date.now() < deadline) {
					await new Promise((resolve) => setTimeout(resolve, 10));
				}
				expect([undefined, "Z"], "startup timeout must terminate an unresponsive child").toContain(
					processState(pid),
				);
			} finally {
				vi.useRealTimers();
				service.dispose();
				await service.disposed;
				expect(isDirectChild(pid), "disposing must reap the terminated child").toBe(false);
			}
		},
		10_000,
	);

	it("waits for previous same-root worker to drain before replacement becomes ready", async () => {
		const first = await fixture(true, 2000);
		first.dispose();
		let drained = false;
		void first.disposed.then(() => {
			drained = true;
		});
		const root = first.status().root;
		const replacement = acquireCodegraph({ cwd: root, grant: { root } });
		services.push(replacement);
		const deadline = Date.now() + 5000;
		while (replacement.status().state !== "ready") {
			if (Date.now() >= deadline)
				throw new Error(`Replacement startup failed: ${JSON.stringify(replacement.status())}`);
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		expect(drained, "replacement must not race previous worker's SQLite lock/watcher").toBe(true);
	});

	it.each(["query", "refresh"] as const)("bounds a stalled %s request and fails closed", async (operation) => {
		const service = await fixture(true);
		vi.useFakeTimers();
		const result = operation === "query" ? service.query({ operation: "search", query: "entry" }) : service.refresh();
		let outcome: Awaited<typeof result> | undefined;
		void result.then((value) => {
			outcome = value;
		});
		await waitForWorkerMessage(service.status().root, operation);
		await vi.advanceTimersByTimeAsync(60_000);
		expect(outcome, "IPC request must settle within 60 seconds").toBeDefined();
		if (outcome && "operation" in outcome) expect(outcome.status).toBe("error");
		expect(service.status().freshness).toBe("stale");
		expect(service.status().lastError).toContain("deadline");
	});
});
