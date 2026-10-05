import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentSession, AgentSessionEvent } from "../src/core/agent-session.ts";
import { type CreateAgentSessionRuntimeFactory, createAgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import { createAgentSessionFromServices, createAgentSessionServices } from "../src/core/agent-session-services.ts";
import type { CodegraphService } from "../src/core/codegraph/types.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { CURRENT_SESSION_VERSION, SessionManager } from "../src/core/session-manager.ts";
import { createHarness } from "./suite/harness.ts";

const roots: string[] = [];
const sessions: AgentSession[] = [];
const model: Model<"anthropic-messages"> = {
	id: "codegraph-lifecycle-review",
	name: "CodeGraph lifecycle review faux model",
	api: "anthropic-messages",
	provider: "faux",
	baseUrl: "http://localhost:0",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1_024,
	maxTokens: 128,
};

function createProject(): { root: string; agentDir: string } {
	const root = mkdtempSync(join(tmpdir(), "pi-codegraph-lifecycle-review-"));
	roots.push(root);
	writeFileSync(join(root, "probe.ts"), "export function EXCLUDED_MARKER(): string { return 'marker'; }\n");
	const agentDir = join(root, "agent-profile");
	mkdirSync(agentDir);
	mkdirSync(join(root, ".pi"));
	return { root, agentDir };
}

async function createSession(root: string, agentDir: string): Promise<AgentSession> {
	const { session } = await createAgentSession({
		cwd: root,
		agentDir,
		model,
		sessionManager: SessionManager.inMemory(root),
		codegraph: { root },
	});
	sessions.push(session);
	return session;
}

async function getStatus(
	session: AgentSession,
): Promise<Extract<AgentSessionEvent, { type: "codegraph_result" }>["status"]> {
	const events: AgentSessionEvent[] = [];
	const unsubscribe = session.subscribe((event) => events.push(event));
	try {
		await session.prompt("/codegraph status");
		const event = events.findLast((entry) => entry.type === "codegraph_result");
		return event?.type === "codegraph_result" ? event.status : undefined;
	} finally {
		unsubscribe();
	}
}

async function queryUntil(
	session: AgentSession,
	predicate: (response: unknown) => boolean,
	query = "EXCLUDED_MARKER",
): Promise<unknown> {
	const deadline = Date.now() + 8_000;
	let response: unknown;
	while (Date.now() < deadline) {
		const codebase = session.agent.state.tools.find((tool) => tool.name === "codebase");
		response = await codebase?.execute("review", { operation: "search", query });
		if (predicate(response)) return response;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error(`Timed out waiting for CodeGraph query result: ${JSON.stringify(response)}`);
}

function childPids(): Set<number> {
	if (process.platform !== "linux") return new Set();
	return new Set(
		readFileSync(`/proc/${process.pid}/task/${process.pid}/children`, "utf8")
			.trim()
			.split(/\s+/)
			.filter(Boolean)
			.map(Number),
	);
}

afterEach(async () => {
	for (const session of sessions.splice(0)) await session.disposeAsync();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("SDK CodeGraph session lifecycle", () => {
	it("does not start indexing when disabled before session creation", async () => {
		const { root, agentDir } = createProject();
		writeFileSync(join(root, ".pi", "settings.json"), JSON.stringify({ codegraph: { enabled: false } }));
		const session = await createSession(root, agentDir);

		expect(session.agent.state.tools.some((tool) => tool.name === "codebase")).toBe(true);
		expect(session.agent.state.tools.some((tool) => tool.name === "read")).toBe(true);
		expect(await getStatus(session)).toMatchObject({ enabled: false, state: "disabled" });
		expect(existsSync(join(root, ".codegraph"))).toBe(false);
	});

	it("keeps the normal read tool usable when graph storage is corrupt", async () => {
		const { root, agentDir } = createProject();
		writeFileSync(join(root, ".codegraph"), "not a directory");
		const session = await createSession(root, agentDir);
		let status = await getStatus(session);
		const deadline = Date.now() + 5_000;
		while (status?.state === "starting" && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 20));
			status = await getStatus(session);
		}
		const read = session.agent.state.tools.find((tool) => tool.name === "read");

		expect(status?.state).toBe("error");
		expect(read).toBeDefined();
		const result = await read!.execute("safety-read", { path: "probe.ts" });
		expect(JSON.stringify(result)).toContain("EXCLUDED_MARKER");
	});

	it("drains the old root before imported-session CodeGraph binds to the new root", async () => {
		const { root: rootA, agentDir } = createProject();
		const { root: rootB } = createProject();
		writeFileSync(join(rootA, "probe.ts"), "export function ROOT_A_ONLY_MARKER() { return 1; }\n");
		writeFileSync(join(rootB, "probe.ts"), "export function ROOT_B_ONLY_MARKER() { return 2; }\n");
		const sessionDirectory = join(rootA, "sessions");
		const baselineChildren = childPids();
		const createRuntime: CreateAgentSessionRuntimeFactory = async ({
			cwd,
			agentDir: runtimeAgentDir,
			sessionManager,
			sessionStartEvent,
		}) => {
			const services = await createAgentSessionServices({
				cwd,
				agentDir: runtimeAgentDir,
				codegraphGrant: { root: cwd },
			});
			const result = await createAgentSessionFromServices({ services, sessionManager, model, sessionStartEvent });
			sessions.push(result.session);
			return { ...result, services, diagnostics: services.diagnostics };
		};
		const runtime = await createAgentSessionRuntime(createRuntime, {
			cwd: rootA,
			agentDir,
			sessionManager: SessionManager.create(rootA, sessionDirectory),
		});
		try {
			const oldSession = runtime.session;
			await queryUntil(
				oldSession,
				(response) => JSON.stringify(response).includes("ROOT_A_ONLY_MARKER"),
				"ROOT_A_ONLY_MARKER",
			);
			expect(await getStatus(oldSession)).toMatchObject({ root: rootA, storagePath: join(rootA, ".codegraph") });
			const oldWorkerPid = [...childPids()].find((pid) => !baselineChildren.has(pid));
			if (process.platform === "linux") expect(oldWorkerPid).toBeDefined();

			const targetSession = SessionManager.create(rootB, sessionDirectory);
			const target = targetSession.getSessionFile();
			writeFileSync(
				target!,
				`${JSON.stringify({
					type: "session",
					version: CURRENT_SESSION_VERSION,
					id: targetSession.getSessionId(),
					timestamp: new Date().toISOString(),
					cwd: rootB,
				})}\n`,
			);
			await runtime.switchSession(target!);
			expect(runtime.cwd).toBe(rootB);
			await queryUntil(
				runtime.session,
				(response) => JSON.stringify(response).includes("ROOT_B_ONLY_MARKER"),
				"ROOT_B_ONLY_MARKER",
			);
			expect(await getStatus(runtime.session)).toMatchObject({
				root: rootB,
				storagePath: join(rootB, ".codegraph"),
			});
			const leakedResult = await runtime.session.agent.state.tools
				.find((tool) => tool.name === "codebase")!
				.execute("root-isolation", { operation: "search", query: "ROOT_A_ONLY_MARKER" });
			expect(JSON.stringify(leakedResult)).not.toContain("ROOT_A_ONLY_MARKER");
			expect(runtime.session.agent.state.tools.some((tool) => tool.name === "read")).toBe(true);
			if (process.platform === "linux") {
				const currentChildren = childPids();
				expect(currentChildren.has(oldWorkerPid!)).toBe(false);
				expect([...currentChildren].filter((pid) => !baselineChildren.has(pid))).toHaveLength(1);
			}

			await runtime.dispose();
			if (process.platform === "linux") expect(childPids()).toEqual(baselineChildren);
		} finally {
			await runtime.dispose();
		}
	});

	it("reloads current settings and stops the engine when indexing is disabled", async () => {
		const { root, agentDir } = createProject();
		const baselineChildren = childPids();
		const session = await createSession(root, agentDir);
		writeFileSync(join(root, ".pi", "settings.json"), JSON.stringify({ codegraph: { enabled: false } }));
		await session.reload();

		expect(session.agent.state.tools.some((tool) => tool.name === "codebase")).toBe(true);
		expect(session.agent.state.tools.some((tool) => tool.name === "read")).toBe(true);
		expect(await getStatus(session)).toMatchObject({ enabled: false, state: "disabled" });
		if (process.platform === "linux") expect(childPids()).toEqual(baselineChildren);
	});

	it("reconciles an updated exclusion policy before session becomes ready", async () => {
		const { root, agentDir } = createProject();
		const session = await createSession(root, agentDir);
		const initialResponse = await queryUntil(session, (response) =>
			JSON.stringify(response).includes("EXCLUDED_MARKER"),
		);
		expect(JSON.stringify(initialResponse)).toContain("EXCLUDED_MARKER");

		writeFileSync(join(root, ".pi", "settings.json"), JSON.stringify({ codegraph: { exclude: ["probe.ts"] } }));
		await session.reload();
		const response = await queryUntil(session, (value) => {
			const serialized = JSON.stringify(value);
			return serialized.includes("current") && !serialized.includes("EXCLUDED_MARKER");
		});
		expect(JSON.stringify(response)).not.toContain("EXCLUDED_MARKER");
	});

	it("disposeAsync still drains when synchronous dispose was already called", async () => {
		let finishDisposal!: () => void;
		let disposalStarted = false;
		let disposeCount = 0;
		const disposed = new Promise<void>((resolve) => {
			finishDisposal = resolve;
		});
		const harness = await createHarness({
			codegraph: {
				status: () => ({
					enabled: false,
					eligible: false,
					root: "/unused",
					storagePath: "/unused/.codegraph",
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
				}),
				query: async () => {
					throw new Error("not used");
				},
				refresh: async () => {
					throw new Error("not used");
				},
				dispose: () => {
					disposalStarted = true;
					disposeCount++;
				},
				disposed,
			} satisfies CodegraphService,
		});
		try {
			harness.session.dispose();
			harness.session.dispose();
			const completion = harness.session.disposeAsync();
			let completed = false;
			void completion.then(() => {
				completed = true;
			});
			await Promise.resolve();
			expect(disposalStarted).toBe(true);
			expect(disposeCount).toBe(1);
			expect(completed).toBe(false);
			finishDisposal();
			await completion;
			expect(completed).toBe(true);
		} finally {
			harness.cleanup();
		}
	});
});
