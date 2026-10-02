import {
	CODEBASE_DEFAULT_LIMIT,
	CODEBASE_MAX_BYTES,
	CODEBASE_MAX_DEPTH,
	CODEBASE_MIN_BYTES,
	type CodebaseResult,
} from "./types.ts";

function serializedBytes(result: CodebaseResult): number {
	return Buffer.byteLength(JSON.stringify(result), "utf8");
}

function createBoundedError(result: CodebaseResult, maxBytes: number): CodebaseResult {
	const fallback: CodebaseResult = {
		status: "error",
		operation: result.operation,
		...(result.direction ? { direction: result.direction } : {}),
		root: result.root,
		revision: result.revision,
		freshness: result.freshness,
		partial: result.partial,
		nodes: [],
		edges: [],
		files: [],
		snippets: [],
		limits: { results: 0, depth: 0, maxBytes },
		truncated: true,
		notice: "Result metadata exceeded output budget; details omitted.",
	};
	if (serializedBytes(fallback) <= maxBytes) return fallback;
	return {
		...fallback,
		root: "",
		revision: null,
		freshness: "unavailable",
		partial: true,
		notice: "Required metadata exceeded output budget.",
	};
}

/** Bound the complete JSON result while keeping JSON valid and identifiers/paths intact. */
export function boundCodebaseResult(result: CodebaseResult, maxBytes: number, offset = 0): CodebaseResult {
	if (!Number.isSafeInteger(maxBytes) || maxBytes < CODEBASE_MIN_BYTES || maxBytes > CODEBASE_MAX_BYTES) {
		throw new RangeError(`maxBytes must be an integer from ${CODEBASE_MIN_BYTES} to ${CODEBASE_MAX_BYTES}`);
	}

	const bounded: CodebaseResult = {
		...result,
		nodes: [...result.nodes],
		edges: [...result.edges],
		files: [...result.files],
		snippets: [...result.snippets],
		limits: {
			results: Math.min(result.limits.results, CODEBASE_DEFAULT_LIMIT),
			depth: Math.min(result.limits.depth, CODEBASE_MAX_DEPTH),
			maxBytes,
		},
	};
	if (serializedBytes(bounded) <= maxBytes) return bounded;

	bounded.truncated = true;
	bounded.notice = "Output truncated to fit byte budget; use offset or a narrower query for more.";
	const paginated = ["search", "symbols", "dependencies"].includes(result.operation);
	const originalCount = result.operation === "dependencies" ? result.files.length : result.nodes.length;
	const endOffset = result.nextOffset ?? offset + originalCount;
	if (paginated && originalCount > 0) bounded.nextOffset = endOffset;
	while (bounded.snippets.length > 0 && serializedBytes(bounded) > maxBytes) {
		bounded.snippets = bounded.snippets.slice(0, -1);
	}
	while (bounded.nodes.length > 0 && serializedBytes(bounded) > maxBytes) {
		bounded.nodes = bounded.nodes.slice(0, -1);
		const nodeIds = new Set([
			...(bounded.subject ? [bounded.subject.id] : []),
			...bounded.nodes.map((node) => node.id),
		]);
		bounded.edges = bounded.edges.filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target));
	}
	if (paginated && result.operation !== "dependencies" && bounded.nodes.length < result.nodes.length) {
		bounded.nextOffset = Math.max(0, endOffset - (result.nodes.length - bounded.nodes.length));
	}
	while (bounded.edges.length > 0 && serializedBytes(bounded) > maxBytes) {
		bounded.edges = bounded.edges.slice(0, -1);
	}
	while (bounded.files.length > 0 && serializedBytes(bounded) > maxBytes) {
		bounded.files = bounded.files.slice(0, -1);
		if (result.operation === "dependencies")
			bounded.nextOffset = Math.max(0, endOffset - (result.files.length - bounded.files.length));
	}
	if (serializedBytes(bounded) <= maxBytes) return bounded;

	return createBoundedError(bounded, maxBytes);
}
