import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { acquireCodegraph } from "../src/core/codegraph/controller.ts";
import type { CodebaseNode, CodegraphService, CodegraphStatus } from "../src/core/codegraph/types.ts";

const fixtures = fileURLToPath(new URL("../../../docs/native-codegraph-artifacts/track-c/fixtures", import.meta.url));
const temporaryRoots: string[] = [];
const services: CodegraphService[] = [];

function createProject(): string {
	const root = mkdtempSync(join(tmpdir(), "pi-codegraph-track-c-"));
	temporaryRoots.push(root);
	cpSync(fixtures, root, { recursive: true });
	return root;
}

async function waitForStatus(
	service: CodegraphService,
	predicate: (status: CodegraphStatus) => boolean,
	label: string,
	timeoutMs = 60_000,
): Promise<CodegraphStatus> {
	const deadline = Date.now() + timeoutMs;
	let last = service.status();
	while (Date.now() < deadline) {
		last = service.status();
		if (predicate(last)) return last;
		if (["error", "disposed"].includes(last.state)) break;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new Error(`${label} timed out; last status: ${JSON.stringify(last)}`);
}

async function startIndexed(root: string, watch = false): Promise<CodegraphService> {
	const service = acquireCodegraph({ cwd: root, grant: { root }, settings: { enabled: true, watch } });
	services.push(service);
	await waitForStatus(
		service,
		(status) => status.state === "ready" && status.freshness === "current",
		"initial index",
	);
	return service;
}

function names(nodes: CodebaseNode[]): Set<string> {
	return new Set(nodes.map((node) => node.name));
}

function relationNames(
	result: { nodes: CodebaseNode[]; edges: Array<{ source: string; target: string }> },
	origin?: string,
): Set<string> {
	const nodeNames = new Map(result.nodes.map((node) => [node.id, node.name]));
	return new Set(
		result.edges.map((edge) => `${nodeNames.get(edge.source) ?? origin}->${nodeNames.get(edge.target) ?? origin}`),
	);
}

async function dispose(service: CodegraphService): Promise<void> {
	service.dispose();
	await service.disposed;
}

beforeAll(() => vi.setConfig({ testTimeout: 120_000 }));

afterEach(async () => {
	vi.unstubAllEnvs();
	for (const service of services.splice(0)) await dispose(service);
	for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Track C public CodeGraph service adversarial coverage", () => {
	it("requires an exact root grant and does not expand consent to a parent", async () => {
		const root = createProject();
		const parent = join(root, "..");
		const missing = acquireCodegraph({ cwd: root });
		const broadened = acquireCodegraph({ cwd: root, grant: { root: parent } });
		services.push(missing, broadened);

		expect(missing.status()).toMatchObject({ enabled: false, eligible: false, state: "disabled" });
		expect(broadened.status()).toMatchObject({ enabled: false, eligible: false, state: "disabled" });
		expect(existsSync(join(root, ".codegraph"))).toBe(false);
		await dispose(missing);
		await dispose(broadened);
	});

	it("indexes real TS/Python fixtures, reports direct relations and keeps unsupported literal search as fallback", async () => {
		const root = createProject();
		const service = await startIndexed(root);
		try {
			const queries = [
				{ operation: "search", query: "createOrder" },
				{ operation: "symbols", file: "src/storage.ts" },
				{ operation: "callers", name: "createOrder" },
				{ operation: "callees", name: "createOrder", depth: 1 },
				{ operation: "dependencies", file: "src/orders.ts", direction: "imports" },
				{ operation: "dependencies", file: "src/persistence.ts", direction: "dependents" },
				{ operation: "impact", name: "validateOrder", depth: 2 },
				{ operation: "context", query: "createOrder", includeCode: true },
				{ operation: "callers", name: "normalize" },
				{ operation: "search", query: "symbolThatDoesNotExist_98317" },
				{ operation: "callers", name: "normalize_job" },
				{ operation: "callees", name: "dispatch_job", depth: 1 },
			] as const;
			const results = await Promise.all(queries.map((request) => service.query(request)));
			for (const result of results) expect(JSON.stringify(result).length).toBeGreaterThan(0);

			expect(names(results[0].nodes)).toContain("createOrder");
			expect(names(results[1].nodes)).toContain("writeRecord");
			expect(names(results[2].nodes)).toContain("postOrder");
			for (const expected of ["validateOrder", "persistOrder", "notifyOrder"])
				expect(names(results[3].nodes)).toContain(expected);
			for (const expected of ["createOrder->validateOrder", "createOrder->persistOrder", "createOrder->notifyOrder"])
				expect(relationNames(results[3], "createOrder")).toContain(expected);
			expect(results[4].files).toEqual(expect.arrayContaining(["src/notifier.ts", "src/persistence.ts"]));
			expect(results[5].files).toContain("src/orders.ts");
			for (const expected of ["validateOrder", "createOrder", "postOrder"])
				expect(names(results[6].nodes)).toContain(expected);
			expect(results[7].snippets.length).toBeGreaterThan(0);
			expect(results[8].status).toBe("ambiguous");
			expect(results[9].nodes).toEqual([]);
			expect(names(results[10].nodes)).toContain("dispatch_job");
			for (const expected of ["normalize_job", "publish_job"]) expect(names(results[11].nodes)).toContain(expected);
			for (const expected of ["dispatch_job->normalize_job", "dispatch_job->publish_job"])
				expect(relationNames(results[11], "dispatch_job")).toContain(expected);
			const literalSearch = await service.query({ operation: "search", query: "MAGIC_LITERAL_42" });
			expect(literalSearch.files).not.toContain("unsupported/notes.txt");
		} finally {
			await dispose(service);
		}
	});

	it("does not index excluded credentials or honor an inherited storage override", async () => {
		const root = createProject();
		const outside = mkdtempSync(join(tmpdir(), "pi-codegraph-outside-"));
		temporaryRoots.push(outside);
		writeFileSync(join(root, ".env"), "SECRET_MARKER_DO_NOT_INDEX=1\n");
		writeFileSync(join(root, "private.pem"), "export const privateCredentialMarker = true;\n");
		vi.stubEnv("CODEGRAPH_DIR", outside);
		const service = await startIndexed(root);
		try {
			const secret = await service.query({ operation: "search", query: "privateCredentialMarker" });
			expect(secret.nodes).toEqual([]);
			expect(service.status().storagePath).toBe(join(root, ".codegraph"));
			expect(existsSync(join(outside, "codegraph.db"))).toBe(false);
		} finally {
			await dispose(service);
		}
	});

	it("rejects a symlinked project-local storage directory before touching its target", async () => {
		const root = createProject();
		const outside = mkdtempSync(join(tmpdir(), "pi-codegraph-symlink-target-"));
		temporaryRoots.push(outside);
		symlinkSync(outside, join(root, ".codegraph"), "dir");
		const service = acquireCodegraph({ cwd: root, grant: { root }, settings: { enabled: true, watch: false } });
		services.push(service);
		try {
			const failed = await waitForStatus(service, (status) => status.state === "error", "storage symlink rejection");
			expect(failed.lastError).toMatch(/Unsafe CodeGraph storage path/);
			expect(readdirSync(outside)).toEqual([]);
		} finally {
			await dispose(service);
		}
	});

	it("shares one root controller until last owner releases and drains its worker", async () => {
		const root = createProject();
		const first = await startIndexed(root);
		const second = acquireCodegraph({ cwd: root, grant: { root }, settings: { enabled: true, watch: false } });
		services.push(second);
		try {
			first.dispose();
			await first.disposed;
			expect(first.status().state).toBe("disposed");
			const stillAvailable = await second.query({ operation: "search", query: "createOrder" });
			expect(names(stillAvailable.nodes)).toContain("createOrder");
		} finally {
			await dispose(second);
		}
		expect(second.status().state).toBe("disposed");
	});

	it("rejects traversal and byte-budget attacks without reading outside the root", async () => {
		const root = createProject();
		const service = await startIndexed(root);
		try {
			const traversal = await service.query({ operation: "symbols", file: "../outside.ts" });
			const absolute = await service.query({ operation: "symbols", file: join(root, "src/orders.ts") });
			const tooSmall = await service.query({ operation: "search", query: "createOrder", maxBytes: 1 });
			expect(traversal.status).toBe("invalid_request");
			expect(absolute.status).toBe("invalid_request");
			expect(tooSmall.status).toBe("invalid_request");
			expect(traversal.nodes).toEqual([]);
			expect(traversal.snippets).toEqual([]);
		} finally {
			await dispose(service);
		}
	});
});
