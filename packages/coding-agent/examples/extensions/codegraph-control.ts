import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Inspect or refresh the current session's native index without another worker. */
export default function codegraphControl(pi: ExtensionAPI) {
	pi.registerTool(
		defineTool({
			name: "codegraph_control",
			label: "CodeGraph control",
			executionMode: "sequential",
			description:
				"Read actual native CodeGraph status or refresh the current session's index. Returns state, freshness, watcher health, counts, errors, and whether native codebase is registered and active. Refresh may ask the user for indexing consent; it does not bypass authorization or change enabled settings.",
			promptSnippet: "Inspect native CodeGraph state and query-tool availability, or refresh its index.",
			promptGuidelines: [
				"Check returned state, freshness, partial status, and errors before claiming indexing succeeded. A refresh may return while initial indexing is still running.",
				"Use codebase for indexed source queries; use rg/read when unavailable or degraded. Never infer authorization from a .codegraph directory.",
			],
			parameters: Type.Object({
				operation: Type.Union([Type.Literal("status"), Type.Literal("refresh")], {
					description: "status reads current native state; refresh requests indexing and may prompt for consent.",
				}),
			}),
			async execute(_toolCallId, params, signal, _onUpdate, ctx) {
				signal?.throwIfAborted();
				if (!ctx.codegraph) {
					throw new Error(
						"Native CodeGraph control API unavailable. Restart Pi with a build supporting ctx.codegraph.",
					);
				}
				const status =
					params.operation === "refresh" ? await ctx.codegraph.refresh(signal) : ctx.codegraph.status();
				const result = {
					status,
					queryTool: {
						registered: pi.getAllTools().some((tool) => tool.name === "codebase"),
						active: pi.getActiveTools().includes("codebase"),
					},
				};
				return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
			},
		}),
	);
}
