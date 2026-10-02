import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodegraphGrant, CodegraphService, CodegraphStatus } from "../../src/core/codegraph/types.ts";
import { createHarness, createTestUiContext } from "./harness.ts";

const status: CodegraphStatus = {
	enabled: true,
	eligible: true,
	root: "/project",
	storagePath: "/project/.codegraph",
	state: "ready",
	revision: { lastIndexedAt: 1, fileCount: 1 },
	freshness: "current",
	partial: false,
	lastSuccess: 1,
	watcher: "healthy",
	pendingChanges: 0,
	activeOperation: null,
	counts: { files: 1, nodes: 2, edges: 1 },
	lastError: null,
};

describe("AgentSession native CodeGraph command", () => {
	let cleanup: (() => void) | undefined;
	afterEach(() => {
		cleanup?.();
		cleanup = undefined;
	});

	it("handles status and refresh without an agent turn or extension bindings", async () => {
		const refresh = vi.fn(async () => ({ ...status, state: "ready" as const }));
		const service = {
			status: vi.fn(() => status),
			query: vi.fn(async () => {
				throw new Error("query must not run for slash commands");
			}),
			refresh,
			dispose: vi.fn(),
			disposed: Promise.resolve(),
		} satisfies CodegraphService;
		const harness = await createHarness({ codegraph: service });
		cleanup = harness.cleanup;

		await harness.session.prompt("/codegraph");
		await harness.session.prompt("/codegraph refresh");

		expect(harness.eventsOfType("codegraph_result").map((event) => event.command)).toEqual(["status", "refresh"]);
		expect(harness.eventsOfType("codegraph_result")[0]?.status).toEqual(status);
		expect(refresh).toHaveBeenCalledOnce();
		expect(harness.getPendingResponseCount()).toBe(0);
		expect(harness.session.messages).toEqual([]);
	});

	it("reports authorization required for headless refresh without asking UI", async () => {
		const authorizationStatus: CodegraphStatus = {
			...status,
			eligible: false,
			state: "disabled",
			reason: "Explicit root-scoped CodeGraph grant required",
		};
		const service = {
			status: vi.fn(() => authorizationStatus),
			query: vi.fn(async () => {
				throw new Error("query must not run for slash commands");
			}),
			refresh: vi.fn(async () => authorizationStatus),
			dispose: vi.fn(),
			disposed: Promise.resolve(),
		} satisfies CodegraphService;
		const harness = await createHarness({ codegraph: service });
		cleanup = harness.cleanup;

		await harness.session.prompt("/codegraph refresh");

		expect(harness.eventsOfType("codegraph_result")[0]?.message).toContain("Authorization required");
		expect(service.refresh).toHaveBeenCalledOnce();
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("asks for exact-root consent in TUI mode, then enables default tool", async () => {
		let harnessCwd = "";
		let receivedGrant: CodegraphGrant | undefined;
		const ungranted = {
			...status,
			root: "",
			storagePath: "",
			eligible: false,
			state: "disabled" as const,
			reason: "Explicit root-scoped CodeGraph grant required",
		};
		const service = {
			status: vi.fn(() => ({ ...ungranted, root: harnessCwd, storagePath: `${harnessCwd}/.codegraph` })),
			query: vi.fn(async () => {
				throw new Error("query must not run for slash commands");
			}),
			refresh: vi.fn(async () => ({ ...status, root: harnessCwd, storagePath: `${harnessCwd}/.codegraph` })),
			dispose: vi.fn(),
			disposed: Promise.resolve(),
		} satisfies CodegraphService;
		const grantedService = {
			...service,
			status: vi.fn(() => ({ ...status, root: harnessCwd, storagePath: `${harnessCwd}/.codegraph` })),
		} satisfies CodegraphService;
		const harness = await createHarness({
			codegraph: service,
			codegraphGrantFactory: (grant) => {
				receivedGrant = grant;
				return grantedService;
			},
		});
		cleanup = harness.cleanup;
		harnessCwd = harness.tempDir;
		const confirm = vi.fn(async (_title: string, _message: string) => true);
		await harness.session.bindExtensions({ mode: "tui", uiContext: createTestUiContext({ confirm }) });

		await harness.session.prompt("/codegraph refresh");

		expect(confirm).toHaveBeenCalledOnce();
		expect(confirm.mock.calls[0]?.[1]).toContain(harness.tempDir);
		expect(receivedGrant).toEqual({ root: harness.tempDir });
		expect(harness.session.getActiveToolNames()).toContain("codebase");
	});

	it("does not add CodeGraph to an explicit or excluded tool loadout", async () => {
		let harnessCwd = "";
		const ungranted = {
			...status,
			root: "",
			storagePath: "",
			eligible: false,
			state: "disabled" as const,
			reason: "Explicit root-scoped CodeGraph grant required",
		};
		const service = {
			status: vi.fn(() => ({ ...ungranted, root: harnessCwd, storagePath: `${harnessCwd}/.codegraph` })),
			query: vi.fn(async () => {
				throw new Error("query must not run for slash commands");
			}),
			refresh: vi.fn(async () => ({ ...status, root: harnessCwd, storagePath: `${harnessCwd}/.codegraph` })),
			dispose: vi.fn(),
			disposed: Promise.resolve(),
		} satisfies CodegraphService;
		const harness = await createHarness({
			codegraph: service,
			codegraphGrantFactory: () => service,
			initialActiveToolNames: ["read"],
			excludedToolNames: ["codebase"],
		});
		cleanup = harness.cleanup;
		harnessCwd = harness.tempDir;
		await harness.session.bindExtensions({
			mode: "tui",
			uiContext: createTestUiContext({ confirm: async () => true }),
		});

		await harness.session.prompt("/codegraph refresh");

		expect(harness.session.getActiveToolNames()).toEqual(["read"]);
		expect(harness.session.getAllTools().map((tool) => tool.name)).not.toContain("codebase");
	});

	it("reports invalid subcommands as usage without querying the graph", async () => {
		const service = {
			status: vi.fn(() => status),
			query: vi.fn(async () => {
				throw new Error("query must not run for slash commands");
			}),
			refresh: vi.fn(async () => status),
			dispose: vi.fn(),
			disposed: Promise.resolve(),
		} satisfies CodegraphService;
		const harness = await createHarness({ codegraph: service });
		cleanup = harness.cleanup;

		await harness.session.prompt("/codegraph drop");

		expect(harness.eventsOfType("codegraph_result")[0]).toMatchObject({
			command: "usage",
			message: "Usage: /codegraph [status|refresh]",
		});
		expect(service.refresh).not.toHaveBeenCalled();
		expect(harness.getPendingResponseCount()).toBe(0);
	});
});
