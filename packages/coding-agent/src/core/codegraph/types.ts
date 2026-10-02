import type { EdgeKind, Language, NodeKind } from "@colbymchenry/codegraph";

/** Explicit indexing consent covers only this canonical root, never its parent. */
export interface CodegraphGrant {
	root: string;
}

export interface CodegraphSettings {
	enabled?: boolean;
	watch?: boolean;
	debounceMs?: number;
	exclude?: string[];
}

export interface CodegraphOptions {
	cwd: string;
	grant?: CodegraphGrant;
	settings?: CodegraphSettings;
}

export type CodegraphState =
	| "disabled"
	| "starting"
	| "indexing"
	| "ready"
	| "refreshing"
	| "degraded"
	| "error"
	| "disposed";

export interface CodegraphStatus {
	enabled: boolean;
	eligible: boolean;
	root: string;
	storagePath: string;
	state: CodegraphState;
	phase?: { name: string; current: number; total: number };
	revision: { lastIndexedAt: number | null; fileCount: number } | null;
	freshness: "unavailable" | "current" | "stale";
	partial: boolean;
	lastSuccess: number | null;
	watcher: "off" | "starting" | "healthy" | "degraded";
	pendingChanges: number;
	activeOperation: "index" | "refresh" | null;
	counts: { files: number; nodes: number; edges: number };
	lastError: string | null;
	reason?: string;
}

export type CodebaseOperation = "search" | "symbols" | "callers" | "callees" | "dependencies" | "impact" | "context";

export interface CodebaseRequest {
	operation: CodebaseOperation;
	query?: string;
	file?: string;
	nodeId?: string;
	name?: string;
	kind?: NodeKind;
	language?: Language;
	direction?: "imports" | "dependents";
	limit?: number;
	offset?: number;
	depth?: number;
	includeCode?: boolean;
	maxBytes?: number;
}

export interface CodebaseNode {
	id: string;
	name: string;
	qualifiedName: string;
	kind: NodeKind;
	language: Language;
	file: string;
	startLine: number;
	endLine: number;
	score?: number;
}

export interface CodebaseEdge {
	source: string;
	target: string;
	kind: EdgeKind;
	line?: number;
	provenance: "tree-sitter" | "scip" | "heuristic" | "unspecified";
}

export interface CodebaseSnippet {
	nodeId: string;
	file: string;
	startLine: number;
	endLine: number;
	code: string;
	truncated: boolean;
}

/** Plain data only: no Maps, raw graph query language, or arbitrary filesystem access. */
export interface CodebaseResult {
	status:
		| "ok"
		| "not_ready"
		| "authorization_required"
		| "disabled"
		| "ambiguous"
		| "not_found"
		| "invalid_request"
		| "cancelled"
		| "error";
	operation: CodebaseOperation;
	direction?: CodebaseRequest["direction"];
	root: string;
	revision: CodegraphStatus["revision"];
	freshness: CodegraphStatus["freshness"];
	partial: boolean;
	/** Indexed query subject for relations; separate from the limited neighbor/file page. */
	subject?: CodebaseNode;
	nodes: CodebaseNode[];
	edges: CodebaseEdge[];
	files: string[];
	snippets: CodebaseSnippet[];
	limits: { results: number; depth: number; maxBytes: number };
	truncated: boolean;
	nextOffset?: number;
	notice?: string;
}

export interface CodegraphService {
	status(): CodegraphStatus;
	query(request: CodebaseRequest, signal?: AbortSignal): Promise<CodebaseResult>;
	refresh(signal?: AbortSignal): Promise<CodegraphStatus>;
	dispose(): void;
	/** Resolves after this owner releases resources; last owner waits for engine drain. */
	disposed: Promise<void>;
}

export const CODEBASE_MAX_BYTES = 8_000;
export const CODEBASE_MIN_BYTES = 1_024;
export const CODEBASE_DEFAULT_LIMIT = 20;
export const CODEBASE_MAX_DEPTH = 2;
