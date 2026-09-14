import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import {
	ContextUsageDialog,
	type ContextUsageDialogData,
} from "../src/modes/interactive/components/context-usage-dialog.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

function createContextUsageData(): ContextUsageDialogData {
	return {
		model: undefined,
		thinkingLevel: "high",
		contextWindow: 1_000_000,
		categories: [
			{ id: "systemPrompt", label: "System prompt", tokens: 3800, color: "warning" },
			{ id: "rules", label: "Rules", tokens: 2000, color: "success" },
			{ id: "mcp", label: "MCP", tokens: 2600, color: "error" },
			{ id: "conversation", label: "Conversation", tokens: 276000, color: "warning" },
			{ id: "toolDefinitions", label: "Tool definitions", tokens: 11700, color: "borderAccent" },
			{ id: "skills", label: "Skills", tokens: 8600, color: "mdLink" },
			{ id: "subagents", label: "Subagents", tokens: 906, color: "thinkingMax" },
		],
	};
}

describe("ContextUsageDialog", () => {
	it("renders the context breakdown with fixed-width panel lines", () => {
		initTheme("dark");
		const dialog = new ContextUsageDialog(createContextUsageData(), () => {});

		const lines = dialog.render(120);
		const plainText = lines.map((line) => stripTerminalSequences(line)).join("\n");

		expect(plainText).toContain("Context • No model 1M High");
		expect(plainText).toContain("Current context usage by category.");
		expect(plainText).toContain("System prompt");
		expect(plainText).toContain("Conversation");
		expect(plainText).toContain("Tool definitions");
		expect(plainText).toContain("Esc to close");
		expect(lines.every((line) => visibleWidth(line) === 120)).toBe(true);
	});

	it("closes on Escape and Ctrl+C", () => {
		const close = vi.fn();
		const dialog = new ContextUsageDialog(createContextUsageData(), close);

		dialog.handleInput("\x1b");
		dialog.handleInput("\x03");

		expect(close).toHaveBeenCalledTimes(2);
	});
});
