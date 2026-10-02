import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireCodegraph } from "../src/core/codegraph/controller.ts";
import type { CodegraphService } from "../src/core/codegraph/types.ts";

const services: CodegraphService[] = [];
const roots: string[] = [];

async function createFixture(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "pi-codegraph-"));
	roots.push(root);
	await mkdir(join(root, "src"));
	await writeFile(
		join(root, "src", "alpha.ts"),
		"export function alpha() { return beta(); }\nexport function beta() { return 2; }\n",
	);
	await writeFile(join(root, "src", "worker.py"), "def python_entry():\n    return 1\n");
	await writeFile(join(root, ".env"), "PI_CODEGRAPH_PRIVATE_MARKER=secret-value\n");
	return root;
}

function acquire(root: string): CodegraphService {
	const service = acquireCodegraph({ cwd: root, grant: { root } });
	services.push(service);
	return service;
}

async function waitForSymbol(
	service: CodegraphService,
	file: string,
	name: string | undefined,
	timeoutMs = 15_000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const result = await service.query({ operation: "symbols", file });
		if (
			result.status === "ok" &&
			(name ? result.nodes.some((node) => node.name === name) : result.nodes.length === 0)
		)
			return;
		await new Promise((resolve) => setTimeout(resolve, 40));
	}
	throw new Error(
		`Timed out waiting for ${file} to ${name ? `contain ${name}` : "disappear"}: ${JSON.stringify(service.status())}`,
	);
}

async function waitForState(service: CodegraphService, states: string[], timeoutMs = 30_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const status = service.status();
		if (states.includes(status.state)) return;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new Error(`Timed out waiting for ${states.join("/")}: ${JSON.stringify(service.status())}`);
}

afterEach(async () => {
	for (const service of services.splice(0)) {
		service.dispose();
		await service.disposed;
	}
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("native CodeGraph controller", () => {
	it("indexes TS and Python under project-local storage and excludes private files", async () => {
		const root = await createFixture();
		await writeFile(
			join(root, "codegraph.json"),
			JSON.stringify({ extensions: { custom: "javascript" }, exclude: ["local-secret.txt"] }),
		);
		const service = acquire(root);
		await waitForState(service, ["ready", "degraded", "error"]);
		expect(service.status().state).toBe("ready");
		expect(service.status().counts.files).toBeGreaterThanOrEqual(2);
		expect(service.status().storagePath).toBe(join(root, ".codegraph"));
		const result = await service.query({ operation: "search", query: "alpha" });
		expect(result.status).toBe("ok");
		expect(result.nodes.some((node) => node.name === "alpha")).toBe(true);
		const policy = JSON.parse(await readFile(join(root, "codegraph.json"), "utf8")) as { exclude: string[] };
		expect(policy.exclude).toContain(".env");
		expect(policy.exclude).toContain(".codegraph/");
		expect(policy.exclude).toContain("local-secret.txt");
		expect(JSON.parse(await readFile(join(root, "codegraph.json"), "utf8")).extensions.custom).toBe("javascript");
		expect(JSON.stringify(result)).not.toContain("secret-value");
	});

	it("shares same-root engine ownership and makes disposed lease queries inert", async () => {
		const root = await createFixture();
		const first = acquire(root);
		const second = acquire(root);
		await waitForState(first, ["ready", "degraded", "error"]);
		expect(second.status().counts.nodes).toBe(first.status().counts.nodes);
		first.dispose();
		await first.disposed;
		expect((await first.query({ operation: "search", query: "alpha" })).status).toBe("cancelled");
		expect(second.status().state).toBe("ready");
		second.dispose();
		await second.disposed;
	});

	it("refreshes real graph after source changes", async () => {
		const root = await createFixture();
		const service = acquire(root);
		await waitForState(service, ["ready", "degraded", "error"]);
		expect(service.status().state).toBe("ready");
		await writeFile(join(root, "src", "gamma.ts"), "export function gamma() { return 3; }\n");
		expect((await service.refresh()).state).toBe("ready");
		expect(
			(await service.query({ operation: "symbols", file: "src/gamma.ts" })).nodes.some(
				(node) => node.name === "gamma",
			),
		).toBe(true);
		await rm(join(root, "src", "alpha.ts"));
		await service.refresh();
		expect((await service.query({ operation: "symbols", file: "src/alpha.ts" })).nodes).toEqual([]);
	});

	it("reopens persisted graph and catches up missed changes", async () => {
		const root = await createFixture();
		const first = acquire(root);
		await waitForState(first, ["ready", "degraded", "error"]);
		expect(first.status().state).toBe("ready");
		first.dispose();
		await first.disposed;
		await writeFile(join(root, "src", "offline.ts"), "export function offlineCatchup() { return 8; }\n");
		const reopened = acquire(root);
		await waitForState(reopened, ["ready", "degraded", "error"]);
		expect(reopened.status().state, JSON.stringify(reopened.status())).toBe("ready");
		expect(
			(await reopened.query({ operation: "symbols", file: "src/offline.ts" })).nodes.some(
				(node) => node.name === "offlineCatchup",
			),
		).toBe(true);
	});

	it("watches add, rename, edit, and delete without per-query indexing", async () => {
		const root = await createFixture();
		const service = acquire(root);
		await waitForState(service, ["ready", "degraded", "error"]);
		expect(service.status().state).toBe("ready");
		expect(service.status().watcher).toBe("healthy");
		const added = join(root, "src", "watched.ts");
		await writeFile(added, "export function watchedSymbol() { return 1; }\n");
		await waitForSymbol(service, "src/watched.ts", "watchedSymbol");
		const renamed = join(root, "src", "renamed.ts");
		await rename(added, renamed);
		await waitForSymbol(service, "src/renamed.ts", "watchedSymbol");
		await waitForSymbol(service, "src/watched.ts", undefined);
		await writeFile(renamed, "export function editedSymbol() { return 2; }\n");
		await waitForSymbol(service, "src/renamed.ts", "editedSymbol");
		await rm(renamed);
		await waitForSymbol(service, "src/renamed.ts", undefined);
	});

	it("isolates distinct roots and coalesces shared refresh", async () => {
		const rootA = await createFixture();
		const rootB = await createFixture();
		const first = acquire(rootA);
		const second = acquire(rootB);
		const shared = acquire(rootB);
		await Promise.all([
			waitForState(first, ["ready", "degraded", "error"]),
			waitForState(second, ["ready", "degraded", "error"]),
		]);
		expect(first.status().storagePath).not.toBe(second.status().storagePath);
		await writeFile(join(rootB, "src", "new_file.ts"), "export function separateRoot() { return 4; }\n");
		const abort = new AbortController();
		const cancelledRefresh = second.refresh(abort.signal);
		abort.abort();
		expect((await cancelledRefresh).lastError).toBe("Refresh cancelled");
		const [left, right] = await Promise.all([second.refresh(), shared.refresh()]);
		expect(left.state).toBe("ready");
		expect(right.state).toBe("ready");
		expect(
			(await shared.query({ operation: "symbols", file: "src/new_file.ts" })).nodes.some(
				(node) => node.name === "separateRoot",
			),
		).toBe(true);
		expect(first.status().counts.files).toBe(2);
	});

	it("does not index source symlinks outside authorized root", async () => {
		const root = await createFixture();
		const outside = await mkdtemp(join(tmpdir(), "pi-codegraph-outside-"));
		roots.push(outside);
		await writeFile(join(outside, "secret.ts"), "export function outsideSecret() { return 'outside-marker'; }\n");
		await symlink(join(outside, "secret.ts"), join(root, "src", "linked.ts"));
		const service = acquire(root);
		await waitForState(service, ["ready", "degraded", "error"]);
		expect(service.status().state).toBe("ready");
		const result = await service.query({ operation: "search", query: "outsideSecret" });
		expect(result.nodes).toEqual([]);
		expect(JSON.stringify(result)).not.toContain("outside-marker");
	});

	it("fails closed on a symlinked database target", async () => {
		const root = await createFixture();
		const target = join(root, "external-database");
		await writeFile(target, "do-not-modify");
		await mkdir(join(root, ".codegraph"), { mode: 0o700 });
		await symlink(target, join(root, ".codegraph", "codegraph.db"));
		const service = acquire(root);
		services.push(service);
		await waitForState(service, ["error", "degraded"]);
		expect(service.status().lastError).toContain("Unsafe CodeGraph storage path: codegraph.db");
		expect(await readFile(target, "utf8")).toBe("do-not-modify");
	});

	it("fails closed on a symlinked storage directory", async () => {
		const root = await createFixture();
		const target = await mkdtemp(join(tmpdir(), "pi-codegraph-storage-target-"));
		roots.push(target);
		await symlink(target, join(root, ".codegraph"));
		const service = acquire(root);
		services.push(service);
		await waitForState(service, ["error", "degraded"]);
		expect(service.status().enabled).toBe(true);
		expect(service.status().lastError).toContain("Unsafe CodeGraph storage path");
		expect(await readFile(join(target, "codegraph.db")).catch(() => undefined)).toBeUndefined();
	});

	it("rejects invalid public options and requires an exact-root grant", async () => {
		const root = await createFixture();
		const denied = acquireCodegraph({ cwd: root });
		services.push(denied);
		expect(denied.status().state).toBe("disabled");
		expect((await denied.query({ operation: "search", query: "x", maxBytes: 100 })).status).toBe("invalid_request");
		expect((await denied.query({ operation: "symbols", file: "../outside.ts" })).status).toBe("invalid_request");
		const child = join(root, "src");
		const narrowed = acquireCodegraph({ cwd: child, grant: { root } });
		services.push(narrowed);
		expect(narrowed.status().eligible).toBe(false);
		const optedOut = acquireCodegraph({ cwd: root, grant: { root }, settings: { enabled: false } });
		services.push(optedOut);
		expect(optedOut.status().enabled).toBe(false);
		expect(optedOut.status().eligible).toBe(true);
	});
});
