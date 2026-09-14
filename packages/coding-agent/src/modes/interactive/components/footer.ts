import { isAbsolute, relative, resolve, sep } from "node:path";
import { type Component, truncateToWidth } from "@earendil-works/pi-tui";
import type { AgentSession } from "../../../core/agent-session.ts";
import { areExperimentalFeaturesEnabled } from "../../../core/experimental.ts";
import type { ReadonlyFooterDataProvider } from "../../../core/footer-data-provider.ts";
import { theme } from "../theme/theme.ts";

const FOOTER_HORIZONTAL_PADDING = 1;

/**
 * Sanitize text for display in a single-line status.
 * Removes newlines, tabs, carriage returns, and other control characters.
 */
function sanitizeStatusText(text: string): string {
	// Replace newlines, tabs, carriage returns with space, then collapse multiple spaces
	return text
		.replace(/[\r\n\t]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}

/**
 * Format token counts for compact footer display.
 */
export function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

function formatContextWindow(count: number): string | undefined {
	if (count <= 0) return undefined;
	if (count >= 1000000 && count % 1000000 === 0) return `${count / 1000000}M`;
	return formatTokens(count);
}

function formatModelName(modelId: string): string {
	if (modelId === "no-model") return "No model";
	return modelId.replace(/\bgpt\b/gi, "GPT");
}

function capitalize(value: string): string {
	if (value.length === 0) return value;
	return `${value.charAt(0).toUpperCase()}${value.slice(1).toLowerCase()}`;
}

function formatThinkingLevel(level: string): string {
	return level === "off" ? "Thinking off" : capitalize(level);
}

export function formatCwdForFooter(cwd: string, home: string | undefined): string {
	if (!home) return cwd;

	const resolvedCwd = resolve(cwd);
	const resolvedHome = resolve(home);
	const relativeToHome = relative(resolvedHome, resolvedCwd);
	const isInsideHome =
		relativeToHome === "" ||
		(relativeToHome !== ".." && !relativeToHome.startsWith(`..${sep}`) && !isAbsolute(relativeToHome));

	if (!isInsideHome) return cwd;
	return relativeToHome === "" ? "~" : `~${sep}${relativeToHome}`;
}

function padFooterLine(line: string, width: number): string {
	if (width <= FOOTER_HORIZONTAL_PADDING * 2) {
		return truncateToWidth(line, width, theme.fg("footerText", "..."));
	}
	const padding = " ".repeat(FOOTER_HORIZONTAL_PADDING);
	return `${padding}${truncateToWidth(line, width - FOOTER_HORIZONTAL_PADDING * 2, theme.fg("footerText", "..."))}${padding}`;
}

/**
 * Footer component that shows model state, context usage, pwd, and branch.
 * Gets git branch and extension statuses from provider.
 */
export class FooterComponent implements Component {
	private session: AgentSession;
	private footerData: ReadonlyFooterDataProvider;

	constructor(session: AgentSession, footerData: ReadonlyFooterDataProvider) {
		this.session = session;
		this.footerData = footerData;
	}

	setSession(session: AgentSession): void {
		this.session = session;
	}

	setAutoCompactEnabled(_enabled: boolean): void {}

	/**
	 * No-op: git branch caching now handled by provider.
	 * Kept for compatibility with existing call sites in interactive-mode.
	 */
	invalidate(): void {
		// No-op: git branch is cached/invalidated by provider
	}

	/**
	 * Clean up resources.
	 * Git watcher cleanup now handled by provider.
	 */
	dispose(): void {
		// Git watcher cleanup handled by provider
	}

	render(width: number): string[] {
		const state = this.session.state;

		// Calculate context usage from session (handles compaction correctly).
		// After compaction, tokens are unknown until the next LLM response.
		const contextUsage = this.session.getContextUsage();
		const contextWindow = contextUsage?.contextWindow ?? state.model?.contextWindow ?? 0;
		const contextPercentValue = contextUsage?.percent ?? 0;
		const contextPercent =
			contextUsage?.percent === undefined || contextUsage.percent === null ? "?" : contextPercentValue.toFixed(1);

		// Replace home directory with ~
		const locationParts = [
			formatCwdForFooter(this.session.sessionManager.getCwd(), process.env.HOME || process.env.USERPROFILE),
		];

		const branch = this.footerData.getGitBranch();

		// Add session name if set
		const sessionName = this.session.sessionManager.getSessionName();
		if (sessionName) {
			locationParts.push(sessionName);
		}

		// Colorize context percentage based on usage
		let contextPercentStr: string;
		const contextPercentDisplay = contextPercent === "?" ? "?" : `${contextPercent}%`;
		if (contextPercentValue > 90) {
			contextPercentStr = theme.fg("error", contextPercentDisplay);
		} else if (contextPercentValue > 70) {
			contextPercentStr = theme.fg("warning", contextPercentDisplay);
		} else {
			contextPercentStr = theme.fg("footerText", contextPercentDisplay);
		}

		const modelParts = [formatModelName(state.model?.id ?? "no-model")];
		const formattedContextWindow = formatContextWindow(contextWindow);
		if (formattedContextWindow) {
			modelParts.push(formattedContextWindow);
		}
		const modelText = theme.fg("footerText", modelParts.join(" "));
		const thinkingText = theme.fg(
			"footerText",
			state.model?.reasoning ? formatThinkingLevel(state.thinkingLevel ?? "off") : "Thinking off",
		);
		const separator = theme.fg("footerText", " · ");
		const metadataParts = [modelText, thinkingText, contextPercentStr];
		if (branch) {
			metadataParts.push(theme.fg("footerText", branch));
		}
		const gitDiffStats = this.footerData.getGitDiffStats();
		if (gitDiffStats && gitDiffStats.filesChanged > 0) {
			metadataParts.push(
				theme.fg("footerText", `${gitDiffStats.filesChanged} edited`),
				`${theme.fg("success", `+${gitDiffStats.insertions}`)} ${theme.fg("error", `-${gitDiffStats.deletions}`)}`,
			);
		}
		if (areExperimentalFeaturesEnabled()) {
			metadataParts.push(theme.bold(theme.fg("warning", "xp")));
		}
		const metadataLine = padFooterLine(metadataParts.join(separator), width);
		const locationLineParts = locationParts.map((part) => theme.fg("footerText", part));
		const locationLine = padFooterLine(locationLineParts.join(separator), width);
		const lines = [metadataLine, locationLine];

		// Add extension statuses on a single line, sorted by key alphabetically
		const extensionStatuses = this.footerData.getExtensionStatuses();
		if (extensionStatuses.size > 0) {
			const sortedStatuses = Array.from(extensionStatuses.entries())
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([, text]) => sanitizeStatusText(text));
			const statusLine = sortedStatuses.join(" ");
			// Truncate to terminal width with dim ellipsis for consistency with footer style
			lines.push(padFooterLine(theme.fg("footerText", statusLine), width));
		}

		return lines;
	}
}
