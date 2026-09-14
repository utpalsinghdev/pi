import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { type Component, type Focusable, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { type ThemeColor, theme } from "../theme/theme.ts";
import { formatTokens } from "./footer.ts";

export type ContextUsageCategoryId =
	| "systemPrompt"
	| "rules"
	| "mcp"
	| "conversation"
	| "toolDefinitions"
	| "skills"
	| "subagents";

export interface ContextUsageCategory {
	id: ContextUsageCategoryId;
	label: string;
	tokens: number;
	color: ThemeColor;
}

export interface ContextUsageDialogModel {
	id: string;
}

export interface ContextUsageDialogData {
	model: ContextUsageDialogModel | undefined;
	thinkingLevel: ThinkingLevel;
	contextWindow: number;
	autoCompactThresholdTokens: number | undefined;
	categories: ContextUsageCategory[];
}

const HORIZONTAL_PADDING = 1;
const MIN_BAR_WIDTH = 12;

function estimatePercent(tokens: number, contextWindow: number): number {
	if (contextWindow <= 0) return 0;
	return (tokens / contextWindow) * 100;
}

function formatPercent(tokens: number, contextWindow: number): string {
	return `${estimatePercent(tokens, contextWindow).toFixed(1)}%`;
}

function formatModelName(modelId: string): string {
	if (modelId === "no-model") return "No model";
	return modelId.replace(/\bgpt\b/gi, "GPT");
}

function formatThinkingLevel(level: ThinkingLevel): string {
	if (level === "off") return "Thinking off";
	return `${level.charAt(0).toUpperCase()}${level.slice(1).toLowerCase()}`;
}

function formatContextWindow(count: number): string {
	if (count <= 0) return "?";
	if (count >= 1000000 && count % 1000000 === 0) return `${count / 1000000}M`;
	return formatTokens(count);
}

function padToWidth(line: string, width: number): string {
	const padding = Math.max(0, width - visibleWidth(line));
	return `${line}${" ".repeat(padding)}`;
}

function panelLine(line: string, width: number): string {
	return theme.bg("editorBg", padToWidth(line, width));
}

function placeLabel(cells: string[], label: string, column: number): void {
	const start = Math.max(0, Math.min(cells.length - label.length, column));
	for (let index = 0; index < label.length && start + index < cells.length; index++) {
		cells[start + index] = label[index] ?? " ";
	}
}

function renderTicks(width: number, contextWindow: number): string {
	const cells = Array.from({ length: width }, () => " ");
	const maxLabel = formatContextWindow(contextWindow);
	const ticks = [
		{ label: "0", ratio: 0 },
		{ label: formatTokens(Math.round(contextWindow * 0.25)), ratio: 0.25 },
		{ label: formatTokens(Math.round(contextWindow * 0.5)), ratio: 0.5 },
		{ label: formatTokens(Math.round(contextWindow * 0.75)), ratio: 0.75 },
		{ label: maxLabel, ratio: 1 },
	];
	for (const tick of ticks) {
		const column = tick.ratio === 1 ? width - tick.label.length : Math.round((width - 1) * tick.ratio);
		placeLabel(cells, tick.label, column);
	}
	return theme.fg("dim", cells.join(""));
}

function renderUsageBar(
	categories: ContextUsageCategory[],
	freeTokens: number,
	contextWindow: number,
	width: number,
	autoCompactThresholdTokens: number | undefined,
): string {
	const barWidth = Math.max(MIN_BAR_WIDTH, width);
	if (contextWindow <= 0) {
		return theme.fg("borderMuted", "█".repeat(barWidth));
	}

	let usedCells = 0;
	const barCells = Array.from({ length: barWidth }, () => ({
		color: "borderMuted" as ThemeColor,
		char: "█",
	}));
	for (const category of categories) {
		if (category.tokens <= 0) continue;
		const rawCells = Math.round((category.tokens / contextWindow) * barWidth);
		const segmentCells = Math.max(1, Math.min(barWidth - usedCells, rawCells));
		if (segmentCells <= 0) continue;
		for (let index = usedCells; index < usedCells + segmentCells; index++) {
			const cell = barCells[index];
			if (cell) {
				cell.color = category.color;
			}
		}
		usedCells += segmentCells;
		if (usedCells >= barWidth) break;
	}

	const remainingCells = Math.max(0, barWidth - usedCells);
	if (remainingCells > 0 && freeTokens <= 0) {
		for (let index = usedCells; index < barWidth; index++) {
			const cell = barCells[index];
			if (cell) {
				cell.char = " ";
			}
		}
	}
	if (autoCompactThresholdTokens !== undefined) {
		const ratio = Math.max(0, Math.min(1, autoCompactThresholdTokens / contextWindow));
		const markerColumn = Math.round((barWidth - 1) * ratio);
		const marker = barCells[markerColumn];
		if (marker) {
			marker.char = "│";
			marker.color = "assistantMessageText";
		}
	}
	return barCells.map((cell) => theme.fg(cell.color, cell.char)).join("");
}

function renderLegendLine(
	category: ContextUsageCategory,
	contextWindow: number,
	columnWidth: number,
	includeRightPadding: boolean,
): string {
	const labelWidth = Math.max(8, columnWidth - 20);
	const value = `${formatTokens(category.tokens)} • ${formatPercent(category.tokens, contextWindow)}`;
	const square = theme.fg(category.color, "█");
	const label = truncateToWidth(category.label, labelWidth, "…", true);
	const valuePadding = Math.max(1, columnWidth - 2 - visibleWidth(label) - value.length);
	const line = `${square} ${label}${" ".repeat(valuePadding)}${value}`;
	return includeRightPadding ? padToWidth(line, columnWidth) : line;
}

export class ContextUsageDialog implements Component, Focusable {
	private readonly data: ContextUsageDialogData;
	private readonly onClose: () => void;
	private _focused = false;

	constructor(data: ContextUsageDialogData, onClose: () => void) {
		this.data = data;
		this.onClose = onClose;
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.onClose();
		}
	}

	invalidate(): void {}

	render(width: number): string[] {
		const innerWidth = Math.max(1, width - HORIZONTAL_PADDING * 2);
		const categories = this.data.categories;
		const usedTokens = categories.reduce((sum, category) => sum + category.tokens, 0);
		const contextWindow = this.data.contextWindow;
		const freeTokens = Math.max(0, contextWindow - usedTokens);
		const totalText = `${formatTokens(usedTokens)} / ${formatContextWindow(contextWindow)}`;
		const percentText = formatPercent(usedTokens, contextWindow);
		const headerLeft = `${theme.bold(theme.fg("mdHeading", "Context"))} ${theme.fg("dim", "•")} ${theme.fg(
			"text",
			`${formatModelName(this.data.model?.id ?? "no-model")} ${formatContextWindow(contextWindow)} ${formatThinkingLevel(this.data.thinkingLevel)}`,
		)}`;
		const headerRight = `${theme.fg("text", totalText)}  ${theme.fg(
			usedTokens > contextWindow * 0.9 ? "error" : usedTokens > contextWindow * 0.7 ? "warning" : "success",
			percentText,
		)}`;
		const headerGap = Math.max(1, innerWidth - visibleWidth(headerLeft) - visibleWidth(headerRight));
		const barWidth = Math.max(1, innerWidth);
		const leftColumnWidth = Math.floor(innerWidth / 2);
		const rightColumnWidth = innerWidth - leftColumnWidth;
		const leftCategories = categories.slice(0, Math.ceil(categories.length / 2));
		const rightCategories = categories.slice(Math.ceil(categories.length / 2));
		const legendRows = Math.max(leftCategories.length, rightCategories.length);
		const lines: string[] = [];

		lines.push(panelLine(theme.fg("mdHeading", "─".repeat(innerWidth)), width));
		lines.push(
			panelLine(`${" ".repeat(HORIZONTAL_PADDING)}${headerLeft}${" ".repeat(headerGap)}${headerRight}`, width),
		);
		lines.push(
			panelLine(`${" ".repeat(HORIZONTAL_PADDING)}${theme.fg("dim", "Current context usage by category.")}`, width),
		);
		lines.push(panelLine("", width));
		lines.push(
			panelLine(
				`${" ".repeat(HORIZONTAL_PADDING)}${renderUsageBar(
					categories,
					freeTokens,
					contextWindow,
					barWidth,
					this.data.autoCompactThresholdTokens,
				)}`,
				width,
			),
		);
		lines.push(panelLine(`${" ".repeat(HORIZONTAL_PADDING)}${renderTicks(barWidth, contextWindow)}`, width));
		lines.push(panelLine("", width));

		for (let row = 0; row < legendRows; row++) {
			const left = leftCategories[row];
			const right = rightCategories[row];
			const leftLine = left
				? renderLegendLine(left, contextWindow, leftColumnWidth, true)
				: " ".repeat(leftColumnWidth);
			const rightLine = right ? renderLegendLine(right, contextWindow, rightColumnWidth, false) : "";
			lines.push(panelLine(`${" ".repeat(HORIZONTAL_PADDING)}${leftLine}${rightLine}`, width));
		}

		lines.push(panelLine("", width));
		lines.push(panelLine(`${" ".repeat(HORIZONTAL_PADDING)}${theme.fg("dim", "Esc to close")}`, width));
		return lines;
	}
}
