import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSession, AgentSessionEvent } from "../src/core/agent-session.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";

const fixtures = new URL("../../../docs/native-codegraph-artifacts/track-c/fixtures", import.meta.url);
const roots: string[] = [];
const sessions: AgentSession[] = [];
const fauxModel: Model<"anthropic-messages"> = {
	id: "track-c-faux",
	name: "Track C faux model",
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
	const root = mkdtempSync(join(tmpdir(), "pi-codegraph-session-track-c-"));
	roots.push(root);
	cpSync(fixtures, root, { recursive: true });
	const agentDir = join(root, "agent-profile");
	mkdirSync(agentDir);
	return { root, agentDir };
}

async function createSession(
	root: string,
	agentDir: string,
	options: { codegraph?: { root: string }; tools?: string[]; excludeTools?: string[] } = {},
) {
	const { session } = await createAgentSession({
		cwd: root,
		agentDir,
		model: fauxModel,
		sessionManager: SessionManager.inMemory(root),
		...options,
	});
	sessions.push(session);
	return session;
}

afterEach(async () => {
	for (const session of sessions.splice(0)) await session.disposeAsync();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Track C SDK/session adversarial coverage", () => {
	it("does not create project state or activate the codebase tool without an exact grant", async () => {
		const { root, agentDir } = createProject();
		const session = await createSession(root, agentDir);
		expect(session.agent.state.tools.some((tool) => tool.name === "codebase")).toBe(false);
		expect(existsSync(join(root, ".codegraph"))).toBe(false);
	});

	it("activates only the granted tool, respects allow/deny filters, and drains on direct SDK disposal", async () => {
		const { root, agentDir } = createProject();
		const session = await createSession(root, agentDir, { codegraph: { root } });
		expect(session.agent.state.tools.filter((tool) => tool.name === "codebase")).toHaveLength(1);
		expect(session.agent.state.tools.some((tool) => tool.name === "read")).toBe(true);
		await session.disposeAsync();
		expect(session.agent.state.tools.some((tool) => tool.name === "codebase")).toBe(true);
	});

	it("keeps codebase out of explicit tool allowlists and denylists", async () => {
		const { root, agentDir } = createProject();
		const allowlisted = await createSession(root, agentDir, { codegraph: { root }, tools: ["read"] });
		expect(allowlisted.agent.state.tools.map((tool) => tool.name)).toEqual(["read"]);
		const excluded = await createSession(root, agentDir, { codegraph: { root }, excludeTools: ["codebase"] });
		expect(excluded.agent.state.tools.some((tool) => tool.name === "codebase")).toBe(false);
	});

	it("handles status and refresh slash commands without a provider request", async () => {
		const { root, agentDir } = createProject();
		const session = await createSession(root, agentDir, { codegraph: { root } });
		const events: AgentSessionEvent[] = [];
		const unsubscribe = session.subscribe((event) => events.push(event));
		const providerCall = vi.spyOn(session.modelRuntime, "streamSimple");
		try {
			await session.prompt("/codegraph status");
			const status = events.find((event) => event.type === "codegraph_result" && event.command === "status");
			expect(status?.type).toBe("codegraph_result");
			if (status?.type === "codegraph_result") expect(status.status?.root).toBe(root);
			await session.prompt("/codegraph refresh");
			expect(events.some((event) => event.type === "codegraph_result" && event.command === "refresh")).toBe(true);
			expect(providerCall).not.toHaveBeenCalled();
		} finally {
			unsubscribe();
		}
	});
});
