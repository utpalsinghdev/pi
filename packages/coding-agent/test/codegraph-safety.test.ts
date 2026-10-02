import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireCodegraph } from "../src/core/codegraph/controller.ts";
import type { CodegraphService } from "../src/core/codegraph/types.ts";

const roots: string[] = [];
const services: CodegraphService[] = [];

async function project(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "pi-codegraph-safety-"));
	roots.push(root);
	await mkdir(join(root, "src"));
	await writeFile(join(root, "src", "entry.ts"), "export function usableEntry() { return 1; }\n");
	return root;
}

function acquire(root: string, settings: { watch?: boolean; debounceMs?: number } = {}): CodegraphService {
	const service = acquireCodegraph({ cwd: root, grant: { root }, settings });
	services.push(service);
	return service;
}

async function settled(service: CodegraphService): Promise<void> {
	const deadline = Date.now() + 30_000;
	while (Date.now() < deadline) {
		if (["ready", "degraded", "error"].includes(service.status().state)) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`CodeGraph did not settle: ${JSON.stringify(service.status())}`);
}

async function waitFor(service: CodegraphService, predicate: () => boolean, timeoutMs = 30_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error(`Timed out waiting for CodeGraph state: ${JSON.stringify(service.status())}`);
}

afterEach(async () => {
	for (const service of services.splice(0)) {
		service.dispose();
		await service.disposed;
	}
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("CodeGraph safety boundaries", () => {
	it("contains corrupt storage and recovers on normal Pi filesystem tools", async () => {
		const root = await project();
		const storage = join(root, ".codegraph");
		await mkdir(storage, { mode: 0o700 });
		await writeFile(join(storage, "codegraph.db"), Buffer.from([0, 255, 0, 1]), { mode: 0o600 });
		const service = acquire(root, { watch: false });
		await settled(service);
		expect(["error", "degraded"]).toContain(service.status().state);
		expect(service.status().lastError).toBeTruthy();
		expect((await service.query({ operation: "search", query: "usableEntry" })).status).toBe("error");
	});

	it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
		"fails closed when project-local storage is genuinely unwritable",
		async () => {
			const root = await project();
			const storage = join(root, ".codegraph");
			await mkdir(storage, { mode: 0o700 });
			await chmod(storage, 0o500);
			try {
				const service = acquire(root, { watch: false });
				await settled(service);
				expect(["error", "degraded"]).toContain(service.status().state);
				expect(service.status().lastError).toBeTruthy();
				expect((await service.query({ operation: "search", query: "usableEntry" })).status).toBe("error");
			} finally {
				await chmod(storage, 0o700);
			}
		},
	);

	it("fails closed for this narrow mixed malformed/5-byte-binary/oversized fixture", async () => {
		const root = await project();
		await writeFile(join(root, "src", "malformed.ts"), "export function broken( {\n");
		await writeFile(join(root, "src", "binary.ts"), Buffer.from([0, 255, 0, 128, 10]));
		await writeFile(
			join(root, "src", "oversized.ts"),
			`export function oversizedSourceMarker() { return 2; }\n${"// padding\n".repeat(100_000)}`,
		);
		const service = acquire(root, { watch: false });
		await settled(service);
		expect(service.status(), JSON.stringify(service.status())).toMatchObject({ state: "degraded", partial: true });
		expect(service.status().counts.nodes).toBeGreaterThan(0);
		const result = await service.query({ operation: "search", query: "usableEntry" });
		expect(result).toMatchObject({ status: "error", nodes: [], edges: [], files: [], snippets: [] });
	});

	it("reconciles source edits made while the initial index is active", async () => {
		const root = await project();
		const racedPath = join(root, "src", "race.ts");
		await writeFile(racedPath, "export function beforeInitialRace() { return 1; }\n");
		for (let index = 0; index < 250; index++) {
			await writeFile(
				join(root, "src", `bulk-${index}.ts`),
				`export function bulk${index}() { return ${index}; }\n`,
			);
		}
		const service = acquire(root, { watch: true, debounceMs: 100 });
		await waitFor(service, () => service.status().activeOperation === "index");
		await writeFile(racedPath, "export function afterInitialRace() { return 2; }\n");
		const deadline = Date.now() + 30_000;
		while (Date.now() < deadline) {
			if (["error", "degraded"].includes(service.status().state)) break;
			const result = await service.query({ operation: "symbols", file: "src/race.ts" });
			if (result.status === "ok" && result.nodes.some((node) => node.name === "afterInitialRace")) {
				expect(result.nodes.some((node) => node.name === "beforeInitialRace")).toBe(false);
				expect(service.status().freshness).toBe("current");
				return;
			}
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
		throw new Error(`Initial-index edit was not reconciled: ${JSON.stringify(service.status())}`);
	});
});
