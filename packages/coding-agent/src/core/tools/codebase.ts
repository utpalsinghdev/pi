import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type Static, Type } from "typebox";
import { boundCodebaseResult } from "../codegraph/format.ts";
import {
	CODEBASE_DEFAULT_LIMIT,
	CODEBASE_MAX_BYTES,
	CODEBASE_MAX_DEPTH,
	CODEBASE_MIN_BYTES,
	type CodebaseOperation,
	type CodebaseRequest,
	type CodebaseResult,
	type CodegraphService,
} from "../codegraph/types.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

const codebaseSchema = Type.Object({
	operation: Type.Union(
		[
			Type.Literal("search"),
			Type.Literal("symbols"),
			Type.Literal("callers"),
			Type.Literal("callees"),
			Type.Literal("dependencies"),
			Type.Literal("impact"),
			Type.Literal("context"),
		],
		{ description: "Graph operation to run" },
	),
	query: Type.Optional(Type.String({ description: "Literal symbol or task query; not regex or embedding search" })),
	file: Type.Optional(Type.String({ description: "Project-relative file path" })),
	nodeId: Type.Optional(Type.String({ description: "Exact graph node ID" })),
	name: Type.Optional(Type.String({ description: "Exact symbol name" })),
	kind: Type.Optional(Type.String({ description: "Symbol kind supported by the graph engine" })),
	language: Type.Optional(Type.String({ description: "Indexed language filter" })),
	direction: Type.Optional(
		Type.Union([Type.Literal("imports"), Type.Literal("dependents")], {
			description: "Dependency direction; defaults to imports and is identified in results",
		}),
	),
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: CODEBASE_DEFAULT_LIMIT })),
	offset: Type.Optional(Type.Integer({ minimum: 0 })),
	depth: Type.Optional(Type.Integer({ minimum: 0, maximum: CODEBASE_MAX_DEPTH })),
	includeCode: Type.Optional(Type.Boolean()),
	maxBytes: Type.Optional(Type.Integer({ minimum: CODEBASE_MIN_BYTES, maximum: CODEBASE_MAX_BYTES })),
});

type CodebaseInput = Static<typeof codebaseSchema>;

// Mirror the pinned release's type literals without loading its heavy engine in Pi's host process.
const NODE_KINDS = [
	"file",
	"module",
	"class",
	"struct",
	"interface",
	"trait",
	"protocol",
	"function",
	"method",
	"property",
	"field",
	"variable",
	"constant",
	"enum",
	"enum_member",
	"type_alias",
	"namespace",
	"parameter",
	"import",
	"export",
	"route",
	"component",
	"union",
] as const satisfies readonly NonNullable<CodebaseRequest["kind"]>[];
const LANGUAGES = [
	"typescript",
	"javascript",
	"tsx",
	"jsx",
	"arkts",
	"python",
	"go",
	"rust",
	"java",
	"c",
	"cpp",
	"csharp",
	"razor",
	"php",
	"ruby",
	"swift",
	"kotlin",
	"dart",
	"svelte",
	"vue",
	"astro",
	"liquid",
	"pascal",
	"scala",
	"lua",
	"luau",
	"objc",
	"r",
	"solidity",
	"nix",
	"yaml",
	"twig",
	"xml",
	"properties",
	"cfml",
	"cfscript",
	"cfquery",
	"cobol",
	"vbnet",
	"erlang",
	"terraform",
	"unknown",
] as const satisfies readonly NonNullable<CodebaseRequest["language"]>[];

function isNodeKind(value: string): value is NonNullable<CodebaseRequest["kind"]> {
	return NODE_KINDS.some((kind) => kind === value);
}

function isLanguage(value: string): value is NonNullable<CodebaseRequest["language"]> {
	return LANGUAGES.some((language) => language === value);
}

function toRequest(input: CodebaseInput): CodebaseRequest {
	return {
		operation: input.operation,
		...(input.query === undefined ? {} : { query: input.query }),
		...(input.file === undefined ? {} : { file: input.file }),
		...(input.nodeId === undefined ? {} : { nodeId: input.nodeId }),
		...(input.name === undefined ? {} : { name: input.name }),
		...(input.kind && isNodeKind(input.kind) ? { kind: input.kind } : {}),
		...(input.language && isLanguage(input.language) ? { language: input.language } : {}),
		...(input.direction === undefined ? {} : { direction: input.direction }),
		...(input.limit === undefined ? {} : { limit: input.limit }),
		...(input.offset === undefined ? {} : { offset: input.offset }),
		...(input.depth === undefined ? {} : { depth: input.depth }),
		...(input.includeCode === undefined ? {} : { includeCode: input.includeCode }),
		...(input.maxBytes === undefined ? {} : { maxBytes: input.maxBytes }),
	};
}

function makeErrorResult(
	service: CodegraphService,
	operation: CodebaseOperation,
	message: string,
	status: CodebaseResult["status"] = "error",
): CodebaseResult {
	const statusSnapshot = service.status();
	return {
		status,
		operation,
		root: statusSnapshot.root,
		revision: statusSnapshot.revision,
		freshness: statusSnapshot.freshness,
		partial: statusSnapshot.partial,
		nodes: [],
		edges: [],
		files: [],
		snippets: [],
		limits: { results: 0, depth: 0, maxBytes: CODEBASE_MAX_BYTES },
		truncated: false,
		notice: message.slice(0, 240),
	};
}

export function createCodebaseToolDefinition(
	service: CodegraphService | (() => CodegraphService),
): ToolDefinition<typeof codebaseSchema> {
	const getService = typeof service === "function" ? service : () => service;
	return {
		name: "codebase",
		label: "codebase",
		description: [
			"Query indexed symbols and static relationships.",
			"Search is lexical metadata retrieval, not embeddings or full-source search.",
			"Use grep for exact text, arbitrary source, generated or unindexed files, and unsupported languages.",
			"Graph links may be heuristic; read source before editing.",
		].join(" "),
		promptSnippet: "Search indexed symbols and static code relationships; use grep/read to verify source.",
		promptGuidelines: [
			"Scores are relative, not confidence. Static impact is incomplete, not runtime tracing or Git-diff analysis.",
		],
		parameters: codebaseSchema,
		async execute(_toolCallId, input, signal) {
			const maxBytes = input.maxBytes ?? CODEBASE_MAX_BYTES;
			const currentService = getService();
			let result: CodebaseResult;
			if (
				(input.kind !== undefined && !isNodeKind(input.kind)) ||
				(input.language !== undefined && !isLanguage(input.language))
			) {
				result = makeErrorResult(
					currentService,
					input.operation,
					"Unknown kind or language filter.",
					"invalid_request",
				);
			} else {
				try {
					result = await currentService.query(toRequest(input), signal);
				} catch (error) {
					result = makeErrorResult(
						currentService,
						input.operation,
						error instanceof Error ? error.message : String(error),
					);
				}
			}
			const bounded = boundCodebaseResult(result, maxBytes, input.offset);
			return { content: [{ type: "text", text: JSON.stringify(bounded) }], details: undefined };
		},
	};
}

export function createCodebaseTool(
	service: CodegraphService | (() => CodegraphService),
): AgentTool<typeof codebaseSchema> {
	return wrapToolDefinition(createCodebaseToolDefinition(service));
}
