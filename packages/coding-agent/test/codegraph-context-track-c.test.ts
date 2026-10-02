import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { acquireCodegraph } from "../src/core/codegraph/controller.ts";
import type { CodebaseNode, CodegraphService } from "../src/core/codegraph/types.ts";

const fixtures = fileURLToPath(new URL("../../../docs/native-codegraph-artifacts/track-c/fixtures", import.meta.url));
const roots: string[] = [];
const services: CodegraphService[] = [];

afterEach(async () => {
	for (const service of services.splice(0)) {
		service.dispose();
		await service.disposed;
	}
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Track C context retrieval", () => {
	it.each([".ts", ".js"])("joins exact query symbols with %s import specifiers", async (extension) => {
		vi.setConfig({ testTimeout: 120_000 });
		const root = mkdtempSync(join(tmpdir(), "pi-codegraph-context-"));
		roots.push(root);
		cpSync(fixtures, root, { recursive: true });
		if (extension === ".js") {
			for (const file of ["routes.ts", "persistence.ts", "orders.ts"]) {
				const path = join(root, "src", file);
				writeFileSync(path, readFileSync(path, "utf8").replaceAll(/(from\s+["']\.\/[^"']+)\.ts(["'])/g, "$1.js$2"));
			}
		}
		const service = acquireCodegraph({ cwd: root, grant: { root }, settings: { enabled: true, watch: false } });
		services.push(service);
		const deadline = Date.now() + 60_000;
		while (service.status().state !== "ready" && Date.now() < deadline)
			await new Promise((resolve) => setTimeout(resolve, 20));
		expect(service.status().state).toBe("ready");

		const result = await service.query({
			operation: "context",
			query: "createOrder persistOrder writeRecord",
			includeCode: true,
		});
		const names = new Set(result.nodes.map((node: CodebaseNode) => node.name));
		const nodeNames = new Map(result.nodes.map((node: CodebaseNode) => [node.id, node.name]));
		const edges = new Set(result.edges.map((edge) => `${nodeNames.get(edge.source)}->${nodeNames.get(edge.target)}`));

		expect(result.status).toBe("ok");
		for (const name of ["createOrder", "persistOrder", "writeRecord"]) expect(names).toContain(name);
		for (const edge of ["createOrder->persistOrder", "persistOrder->writeRecord"]) expect(edges).toContain(edge);
		const dependencies = await service.query({
			operation: "dependencies",
			file: "src/orders.ts",
			direction: "imports",
		});
		expect(dependencies.status).toBe("ok");
		expect(dependencies.files).toEqual(["src/notifier.ts", "src/persistence.ts"]);
		expect(result.snippets.map((snippet) => snippet.file)).toEqual(
			expect.arrayContaining(["src/orders.ts", "src/persistence.ts", "src/storage.ts"]),
		);
		expect(result.nodes.length).toBeLessThanOrEqual(result.limits.results);
		expect(result.edges.length).toBeLessThanOrEqual(result.limits.results * 3);
	});

	it("keeps duplicate names ambiguous and misses prose for text fallback", async () => {
		vi.setConfig({ testTimeout: 120_000 });
		const root = mkdtempSync(join(tmpdir(), "pi-codegraph-context-"));
		roots.push(root);
		cpSync(fixtures, root, { recursive: true });
		const service = acquireCodegraph({ cwd: root, grant: { root }, settings: { enabled: true, watch: false } });
		services.push(service);
		const deadline = Date.now() + 60_000;
		while (service.status().state !== "ready" && Date.now() < deadline)
			await new Promise((resolve) => setTimeout(resolve, 20));

		expect((await service.query({ operation: "context", query: "normalize" })).status).toBe("ambiguous");
		expect(
			(await service.query({ operation: "context", query: "where are orders checked before being saved" })).status,
		).toBe("not_found");
	});
});
