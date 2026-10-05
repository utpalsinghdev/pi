import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	getCurrentTools,
	type Model,
	normalizeContext,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import codegraphControl from "../examples/extensions/codegraph-control.ts";
import type { AgentSession, AgentSessionEvent } from "../src/core/agent-session.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createTestUiContext } from "./suite/harness.ts";

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
	options: {
		codegraph?: { root: string };
		tools?: string[];
		excludeTools?: string[];
		resourceLoader?: DefaultResourceLoader;
		settingsManager?: SettingsManager;
	} = {},
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
	it("declares codebase before consent without creating project state or allowing queries", async () => {
		const { root, agentDir } = createProject();
		const session = await createSession(root, agentDir);
		const tool = session.agent.state.tools.find((tool) => tool.name === "codebase");
		expect(tool).toBeDefined();
		expect(session.getAllTools().find((entry) => entry.name === "codebase")?.sourceInfo.path).toBe(
			"builtin:codebase",
		);
		expect(session.systemPrompt).toContain("codebase:");
		const result = await tool!.execute("no-consent", { operation: "search", query: "anything" });
		expect(JSON.parse(result.content[0].type === "text" ? result.content[0].text : "{}").status).toBe(
			"authorization_required",
		);
		expect(existsSync(join(root, ".codegraph"))).toBe(false);
	});

	it("includes native codebase schema and guidance in provider input before authorization", async () => {
		const { root, agentDir } = createProject();
		const session = await createSession(root, agentDir);
		vi.spyOn(session.modelRuntime, "hasConfiguredAuth").mockReturnValue(true);
		const provider = vi.spyOn(session.modelRuntime, "streamSimple").mockImplementation((model) => {
			const stream = createAssistantMessageEventStream();
			stream.end({ ...fauxAssistantMessage("ok"), api: model.api, provider: model.provider, model: model.id });
			return stream;
		});
		await session.prompt("Say ok.");
		expect(provider).toHaveBeenCalledOnce();
		const context = normalizeContext(provider.mock.calls[0]![1]);
		const tools = getCurrentTools(context.messages);
		expect(tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(["read", "edit", "codebase"]));
		expect(tools.find((tool) => tool.name === "codebase")?.description).toContain("indexed symbols");
		expect(JSON.stringify(context.messages)).toContain("codebase:");
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

	it("returns actual native status through the control extension and retains declarations across refresh/reload", async () => {
		const { root, agentDir } = createProject();
		const settingsManager = SettingsManager.inMemory();
		const resourceLoader = new DefaultResourceLoader({
			cwd: root,
			agentDir,
			settingsManager,
			extensionFactories: [codegraphControl],
		});
		await resourceLoader.reload();
		const session = await createSession(root, agentDir, { codegraph: { root }, resourceLoader, settingsManager });
		const before = session.getActiveToolNames();
		const promptBefore = session.systemPrompt;
		const providerCall = vi.spyOn(session.modelRuntime, "streamSimple");
		for (const operation of ["status", "refresh"] as const) {
			const control = session.agent.state.tools.find((tool) => tool.name === "codegraph_control")!;
			const result = await control.execute(operation, { operation });
			const payload = JSON.parse(result.content[0].type === "text" ? result.content[0].text : "{}");
			expect(payload.status.root).toBe(root);
			expect(payload.status.enabled).toBe(true);
			expect(payload.queryTool).toEqual({ registered: true, active: true });
			expect(session.getActiveToolNames()).toEqual(before);
			expect(session.systemPrompt).toBe(promptBefore);
		}
		await session.reload();
		expect(session.getActiveToolNames()).toEqual(before);
		const control = session.agent.state.tools.find((tool) => tool.name === "codegraph_control")!;
		const result = await control.execute("after-reload", { operation: "status" });
		expect(result.details).toMatchObject({ status: { root, enabled: true } });
		expect(providerCall).not.toHaveBeenCalled();
	});

	it("reports missing authorization through control without creating storage", async () => {
		const { root, agentDir } = createProject();
		const settingsManager = SettingsManager.inMemory();
		const resourceLoader = new DefaultResourceLoader({
			cwd: root,
			agentDir,
			settingsManager,
			extensionFactories: [codegraphControl],
		});
		await resourceLoader.reload();
		const session = await createSession(root, agentDir, { resourceLoader, settingsManager });
		const control = session.agent.state.tools.find((tool) => tool.name === "codegraph_control")!;
		for (const operation of ["status", "refresh"] as const) {
			const result = await control.execute(operation, { operation });
			expect(result.details).toMatchObject({
				status: { enabled: false, reason: "Explicit root-scoped CodeGraph grant required" },
				queryTool: { registered: true, active: true },
			});
		}
		expect(existsSync(join(root, ".codegraph"))).toBe(false);
	});

	it.each([false, true])("preserves user consent when a model refreshes (approval: %s)", async (approved) => {
		const { root, agentDir } = createProject();
		const settingsManager = SettingsManager.inMemory({ codegraph: { watch: false } });
		const resourceLoader = new DefaultResourceLoader({
			cwd: root,
			agentDir,
			settingsManager,
			extensionFactories: [codegraphControl],
		});
		await resourceLoader.reload();
		const session = await createSession(root, agentDir, { resourceLoader, settingsManager });
		const confirm = vi.fn(async () => approved);
		await session.bindExtensions({ mode: "tui", uiContext: createTestUiContext({ confirm }) });
		const toolsBefore = session.getActiveToolNames();
		const promptBefore = session.systemPrompt;
		const control = session.agent.state.tools.find((tool) => tool.name === "codegraph_control")!;
		const result = await control.execute("consent", { operation: "refresh" });
		expect(confirm).toHaveBeenCalledWith("Allow CodeGraph indexing?", expect.stringContaining(root));
		expect(result.details).toMatchObject({ status: { enabled: approved } });
		expect(session.getActiveToolNames()).toEqual(toolsBefore);
		expect(session.systemPrompt).toBe(promptBefore);
		const tool = session.agent.state.tools.find((entry) => entry.name === "codebase")!;
		if (!approved) {
			const query = await tool.execute("denied", { operation: "search", query: "validateOrder" });
			expect(JSON.parse(query.content[0].type === "text" ? query.content[0].text : "{}").status).toBe(
				"authorization_required",
			);
			expect(existsSync(join(root, ".codegraph"))).toBe(false);
			return;
		}
		let found = false;
		const deadline = Date.now() + 20_000;
		while (Date.now() < deadline) {
			const query = await tool.execute("granted", { operation: "search", query: "validateOrder" });
			const payload = JSON.parse(query.content[0].type === "text" ? query.content[0].text : "{}");
			if (payload.status === "ok" && payload.nodes.some((node: { name: string }) => node.name === "validateOrder")) {
				found = true;
				break;
			}
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
		expect(found).toBe(true);
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
