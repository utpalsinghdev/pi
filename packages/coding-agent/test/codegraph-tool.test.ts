import { describe, expect, it, vi } from "vitest";
import { boundCodebaseResult } from "../src/core/codegraph/format.ts";
import type { CodebaseNode, CodebaseResult, CodegraphService, CodegraphStatus } from "../src/core/codegraph/types.ts";
import type { ExtensionToolContext } from "../src/core/extensions/types.ts";
import { createCodebaseToolDefinition } from "../src/core/tools/codebase.ts";
import { toJsonEvent } from "../src/modes/json-event.ts";

const serviceStatus: CodegraphStatus = {
	enabled: false,
	eligible: false,
	root: "/project",
	storagePath: "/project/.codegraph",
	state: "disabled",
	revision: null,
	freshness: "unavailable",
	partial: true,
	lastSuccess: null,
	watcher: "off",
	pendingChanges: 0,
	activeOperation: null,
	counts: { files: 0, nodes: 0, edges: 0 },
	lastError: null,
};

const result: CodebaseResult = {
	status: "ok",
	operation: "search",
	root: "/project",
	revision: { lastIndexedAt: 1, fileCount: 1 },
	freshness: "current",
	partial: false,
	nodes: [],
	edges: [],
	files: [],
	snippets: [],
	limits: { results: 20, depth: 2, maxBytes: 8_000 },
	truncated: false,
};

describe("native codebase tool", () => {
	it("bounds valid JSON without cutting identifiers or paths", () => {
		const nodes: CodebaseNode[] = Array.from({ length: 20 }, (_, index) => ({
			id: `node-${index}`,
			name: `symbol-${index}`,
			qualifiedName: `src/file-${index}.ts::symbol-${index}`,
			kind: "function",
			language: "typescript",
			file: `src/file-${index}.ts`,
			startLine: 1,
			endLine: 2,
		}));
		const bounded = boundCodebaseResult({ ...result, nodes, nextOffset: nodes.length }, 1_024);
		const json = JSON.stringify(bounded);

		expect(Buffer.byteLength(json, "utf8")).toBeLessThanOrEqual(1_024);
		expect(JSON.parse(json)).toEqual(bounded);
		expect(bounded.truncated).toBe(true);
		expect(bounded.nextOffset).toBe(bounded.nodes.length);
		for (const node of bounded.nodes) {
			expect(node.id).toMatch(/^node-\d+$/);
			expect(node.file).toMatch(/^src\/file-\d+\.ts$/);
		}
	});

	it("keeps resolved subject endpoints when byte truncation removes other nodes", () => {
		const subject: CodebaseNode = {
			id: "seed",
			name: "entry",
			qualifiedName: "src/entry.ts::entry",
			kind: "function",
			language: "typescript",
			file: "src/entry.ts",
			startLine: 1,
			endLine: 2,
		};
		const neighbor: CodebaseNode = { ...subject, id: "neighbor", name: "helper" };
		const oversized: CodebaseNode = { ...neighbor, id: "omitted", qualifiedName: "x".repeat(2_000) };
		const bounded = boundCodebaseResult(
			{
				...result,
				operation: "callees",
				subject,
				nodes: [neighbor, oversized],
				edges: [{ source: subject.id, target: neighbor.id, kind: "calls", provenance: "tree-sitter" }],
			},
			1_024,
		);
		expect(bounded.status).toBe("ok");
		expect(bounded.subject).toEqual(subject);
		expect(bounded.nodes).toEqual([neighbor]);
		expect(bounded.edges).toHaveLength(1);
		expect(Buffer.byteLength(JSON.stringify(bounded), "utf8")).toBeLessThanOrEqual(1_024);
	});

	it("returns bounded failure rather than unproven dependency files if subject metadata cannot fit", () => {
		const subject: CodebaseNode = {
			id: "file",
			name: "entry.ts",
			qualifiedName: "x".repeat(2_000),
			kind: "file",
			language: "typescript",
			file: "src/entry.ts",
			startLine: 1,
			endLine: 2,
		};
		const bounded = boundCodebaseResult(
			{ ...result, operation: "dependencies", direction: "imports", subject, files: ["src/helper.ts"] },
			1_024,
		);
		expect(bounded).toMatchObject({ status: "error", direction: "imports", files: [] });
		expect(bounded).not.toHaveProperty("subject");
		expect(Buffer.byteLength(JSON.stringify(bounded), "utf8")).toBeLessThanOrEqual(1_024);
	});

	it("continues dependency pagination at first omitted file after byte truncation", () => {
		const files = Array.from({ length: 20 }, (_, index) => `src/${"path".repeat(20)}/dependency-${index}.ts`);
		const bounded = boundCodebaseResult({ ...result, operation: "dependencies", files, nextOffset: 30 }, 1_024);
		expect(bounded.truncated).toBe(true);
		expect(bounded.files.length).toBeLessThan(files.length);
		expect(bounded.nextOffset).toBe(10 + bounded.files.length);
		expect(Buffer.byteLength(JSON.stringify(bounded), "utf8")).toBeLessThanOrEqual(1_024);
	});

	it("adds continuation when only the byte budget omits final-page symbols", () => {
		const nodes: CodebaseNode[] = Array.from({ length: 20 }, (_, index) => ({
			id: `node-${index}`,
			name: `symbol-${index}`,
			qualifiedName: `src/file-${index}.ts::symbol-${index}`,
			kind: "function",
			language: "typescript",
			file: `src/file-${index}.ts`,
			startLine: 1,
			endLine: 2,
		}));
		const bounded = boundCodebaseResult({ ...result, operation: "symbols", nodes }, 1_024, 10);
		expect(bounded.truncated).toBe(true);
		expect(bounded.nextOffset).toBe(10 + bounded.nodes.length);
	});

	it("returns bounded error metadata instead of cutting an oversized root path", () => {
		const bounded = boundCodebaseResult({ ...result, root: `/project/${"x".repeat(10_000)}` }, 1_024);
		const json = JSON.stringify(bounded);

		expect(bounded.status).toBe("error");
		expect(bounded.root).toBe("");
		expect(Buffer.byteLength(json, "utf8")).toBeLessThanOrEqual(1_024);
		expect(JSON.parse(json)).toEqual(bounded);
	});

	it("rejects unknown symbol filters before querying", async () => {
		const query = vi.fn(async () => result);
		const service: CodegraphService = {
			status: () => serviceStatus,
			query,
			refresh: async () => serviceStatus,
			dispose: () => {},
			disposed: Promise.resolve(),
		};
		const tool = createCodebaseToolDefinition(service);
		const outcome = await tool.execute(
			"tool-call",
			{ operation: "symbols", kind: "bogus" },
			undefined,
			undefined,
			{} as ExtensionToolContext,
		);
		const payload = outcome.content.find((part) => part.type === "text");

		expect(query).not.toHaveBeenCalled();
		if (payload?.type !== "text") throw new Error("codebase response must be text");
		expect(JSON.parse(payload.text)).toMatchObject({ status: "invalid_request" });
	});

	it("preserves command results as one framed JSON/RPC event", () => {
		const event = {
			type: "codegraph_result",
			command: "status",
			message: "CodeGraph ready",
		} as const;
		expect(JSON.parse(JSON.stringify(toJsonEvent(event)))).toEqual(event);
	});

	it("rejects budgets below the smallest supported envelope", () => {
		expect(() => boundCodebaseResult(result, 1_023)).toThrow(/maxBytes/);
	});

	it("exposes one operation schema and caps the final provider-visible JSON payload", async () => {
		const oversizedResult: CodebaseResult = {
			...result,
			nodes: Array.from({ length: 20 }, (_, index) => ({
				id: `node-${index}`,
				name: `symbol-${index}`,
				qualifiedName: `src/file-${index}.ts::symbol-${index}`,
				kind: "function",
				language: "typescript",
				file: `src/file-${index}.ts`,
				startLine: 1,
				endLine: 2,
			})),
		};
		const query = vi.fn(async () => oversizedResult);
		const service: CodegraphService = {
			status: () => serviceStatus,
			query,
			refresh: async () => serviceStatus,
			dispose: () => {},
			disposed: Promise.resolve(),
		};
		const tool = createCodebaseToolDefinition(service);
		const outcome = await tool.execute(
			"tool-call",
			{ operation: "search", query: "literal SymbolName", maxBytes: 1_024 },
			undefined,
			undefined,
			{} as ExtensionToolContext,
		);
		const payload = outcome.content.find((part) => part.type === "text");

		expect(tool.name).toBe("codebase");
		expect(query).toHaveBeenCalledWith(
			{ operation: "search", query: "literal SymbolName", maxBytes: 1_024 },
			undefined,
		);
		expect(payload?.type).toBe("text");
		if (payload?.type !== "text") throw new Error("codebase response must be text");
		const parsed: unknown = JSON.parse(payload.text);
		expect(parsed).toMatchObject({ truncated: true });
		expect(Buffer.byteLength(payload.text, "utf8")).toBeLessThanOrEqual(1_024);
		expect(outcome.details).toBeUndefined();
	});
});
