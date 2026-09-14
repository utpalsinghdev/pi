import { visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import type { GitDiffStats, ReadonlyFooterDataProvider } from "../src/core/footer-data-provider.ts";
import { FooterComponent, formatCwdForFooter } from "../src/modes/interactive/components/footer.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

type AssistantUsage = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: { total: number };
};

function createSession(options: {
	sessionName: string;
	modelId?: string;
	provider?: string;
	reasoning?: boolean;
	thinkingLevel?: string;
	usage?: AssistantUsage;
	branchUsage?: AssistantUsage;
	compactionUsage?: AssistantUsage;
	toolUsage?: AssistantUsage;
	usingSubscription?: boolean;
	autoCompactionEnabled?: boolean;
	reserveTokens?: number;
}): AgentSession {
	const usage = options.usage;
	const entries: Array<Record<string, unknown>> = [];

	if (usage !== undefined) {
		entries.push({
			type: "message",
			message: {
				role: "assistant",
				usage,
			},
		});
	}

	if (options.branchUsage !== undefined) {
		entries.push({
			type: "branch_summary",
			usage: options.branchUsage,
		});
	}

	if (options.compactionUsage !== undefined) {
		entries.push({
			type: "compaction",
			usage: options.compactionUsage,
		});
	}

	if (options.toolUsage !== undefined) {
		entries.push({
			type: "message",
			message: {
				role: "toolResult",
				usage: options.toolUsage,
			},
		});
	}

	const session = {
		state: {
			model: {
				id: options.modelId ?? "test-model",
				provider: options.provider ?? "test",
				contextWindow: 200_000,
				reasoning: options.reasoning ?? false,
			},
			thinkingLevel: options.thinkingLevel ?? "off",
		},
		sessionManager: {
			getEntries: () => entries,
			getSessionName: () => options.sessionName,
			getCwd: () => "/tmp/project",
		},
		getContextUsage: () => ({ contextWindow: 200_000, percent: 12.3 }),
		autoCompactionEnabled: options.autoCompactionEnabled ?? true,
		settingsManager: {
			getCompactionReserveTokens: () => options.reserveTokens ?? 16_384,
		},
		modelRuntime: {
			isUsingSubscription: () => options.usingSubscription ?? false,
		},
	};

	return session as unknown as AgentSession;
}

function createFooterData(providerCount: number, gitDiffStats: GitDiffStats | null = null): ReadonlyFooterDataProvider {
	const provider = {
		getGitBranch: () => "main",
		getGitDiffStats: () => gitDiffStats,
		getExtensionStatuses: () => new Map<string, string>(),
		getAvailableProviderCount: () => providerCount,
		onBranchChange: (callback: () => void) => {
			void callback;
			return () => {};
		},
	};

	return provider;
}

describe("formatCwdForFooter", () => {
	it("does not abbreviate sibling paths that share the home prefix", () => {
		expect(formatCwdForFooter("/home/user2", "/home/user")).toBe("/home/user2");
	});

	it("abbreviates the home directory and descendants", () => {
		expect(formatCwdForFooter("/home/user", "/home/user")).toBe("~");
		expect(formatCwdForFooter("/home/user/project", "/home/user")).toBe("~/project");
	});
});

describe("FooterComponent width handling", () => {
	beforeAll(() => {
		initTheme(undefined, false);
	});

	it("keeps all lines within width for wide session names", () => {
		const width = 93;
		const session = createSession({ sessionName: "한글".repeat(30) });
		const footer = new FooterComponent(session, createFooterData(1));

		const lines = footer.render(width);
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});

	it("keeps metadata line within width for wide model names", () => {
		const width = 60;
		const session = createSession({
			sessionName: "",
			modelId: "模".repeat(30),
			provider: "공급자",
			reasoning: true,
			thinkingLevel: "high",
		});
		const footer = new FooterComponent(session, createFooterData(2));

		const lines = footer.render(width);
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});

	it("renders cursor-style model metadata and location", () => {
		const session = createSession({
			sessionName: "review",
			modelId: "gpt-5.5",
			reasoning: true,
			thinkingLevel: "max",
		});
		const footer = new FooterComponent(
			session,
			createFooterData(1, { filesChanged: 8, insertions: 94, deletions: 227 }),
		);
		const lines = footer.render(120).map((line) => stripAnsi(line));

		expect(lines[0]).toBe(" GPT-5.5 200k · Max · [█░░░░░░░│░] 12.3% · main · 8 edited · +94 -227 ");
		expect(lines[1]).toBe(" /tmp/project · review ");
	});

	it("omits the auto-compaction marker when auto compaction is disabled", () => {
		const session = createSession({
			sessionName: "",
			modelId: "gpt-5.5",
			reasoning: true,
			thinkingLevel: "medium",
			autoCompactionEnabled: false,
		});
		const footer = new FooterComponent(session, createFooterData(1));
		const lines = footer.render(120).map((line) => stripAnsi(line));

		expect(lines[0]).toBe(" GPT-5.5 200k · Medium · [█░░░░░░░░░] 12.3% · main ");
	});

	it("omits diff stats when there are no edited files", () => {
		const session = createSession({
			sessionName: "",
			modelId: "gpt-5.5",
			reasoning: true,
			thinkingLevel: "max",
		});
		const footer = new FooterComponent(
			session,
			createFooterData(1, { filesChanged: 0, insertions: 0, deletions: 0 }),
		);
		const lines = footer.render(120).map((line) => stripAnsi(line));

		expect(lines[0]).toBe(" GPT-5.5 200k · Max · [█░░░░░░░│░] 12.3% · main ");
		expect(lines[1]).toBe(" /tmp/project ");
	});
});
