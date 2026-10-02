import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { actualFacts, fixtureDirectory, frozenHypotheses, groundTruthPath, runTargetedTextBaseline, scoreFacts, shouldUseTextFallback, validateFixtures } from "./benchmark-native-codegraph.mjs";

const manifest = validateFixtures();
const groundTruth = JSON.parse(readFileSync(new URL("../docs/native-codegraph-artifacts/track-c/ground-truth.json", import.meta.url), "utf8"));

test("frozen ground truth covers every public operation and preserves literal fallback cases", () => {
	assert.equal(manifest.tasks, 15);
	assert.deepEqual(new Set(manifest.operations), new Set(["search", "symbols", "callers", "callees", "dependencies", "impact", "context"]));
	assert.ok(groundTruth.tasks.some((task) => task.id === "literal-comment-fallback"));
	assert.ok(groundTruth.tasks.some((task) => task.id === "ambiguous-normalize"));
	assert.ok(groundTruth.tasks.some((task) => task.id === "missing-symbol"));
	assert.ok(groundTruth.tasks.some((task) => task.id === "paraphrase-fallback"));
	assert.ok(manifest.files >= 10);
	assert.ok(fixtureDirectory.endsWith("fixtures"));
});

test("required direct structural edges and independently stated evidence are explicit", () => {
	const requiredEdges = groundTruth.tasks.flatMap((task) => task.expected.edges);
	assert.ok(requiredEdges.includes("createOrder->validateOrder"));
	assert.ok(requiredEdges.includes("dispatch_job->normalize_job"));
	for (const task of groundTruth.tasks) {
		assert.ok(task.evidence.length > 0, task.id);
		for (const file of task.expected.files) assert.ok(manifest.fixtureSha256[file], `${task.id}: ${file}`);
	}
});

test("fallback selection uses request/result behavior, never ground-truth expected file lists", () => {
	const literal = groundTruth.tasks.find((task) => task.id === "literal-comment-fallback");
	const exactSymbol = groundTruth.tasks.find((task) => task.id === "search-create-order");
	assert.ok(literal && exactSymbol);
	assert.equal(shouldUseTextFallback(literal, { status: "ok", nodes: [{ name: "literalFixture" }] }), true);
	assert.equal(shouldUseTextFallback(exactSymbol, { status: "ok", nodes: [{ name: "createOrder" }] }), false);
	assert.equal(shouldUseTextFallback(exactSymbol, { status: "ok", nodes: [] }), true);
	assert.equal(shouldUseTextFallback(exactSymbol, { status: "ambiguous", nodes: [] }), true);
});

test("fact scoring treats empty expected sets as vacuous recall but still penalizes false positives", () => {
	assert.deepEqual(scoreFacts([], []), { recall: 1, precision: 1, missing: [], unexpected: [] });
	assert.deepEqual(scoreFacts([], ["unexpected"]), { recall: 1, precision: 0, missing: [], unexpected: ["unexpected"] });
});

test("empty retrieval never credits requested names or files", () => {
	for (const operation of ["callers", "callees", "dependencies", "symbols"]) {
		const task = { operation, request: { operation, name: "requested", file: "src/requested.ts" } };
		assert.deepEqual(actualFacts(task, { operation, nodes: [], files: [], edges: [] }), { files: [], symbols: [], edges: [] });
	}
});

test("missing edge endpoints receive no query-derived credit", () => {
	const node = { id: "neighbor", name: "related", file: "src/related.ts" };
	for (const operation of ["callers", "callees"]) {
		const edge = operation === "callers" ? { source: node.id, target: "missing" } : { source: "missing", target: node.id };
		const task = { operation, request: { name: "requested" } };
		assert.deepEqual(actualFacts(task, { operation, nodes: [node], edges: [edge] }), { files: [node.file], symbols: [node.name], edges: [] });
	}
});

test("returned subject supplies explicit symbol and dependency provenance, not query echoes", () => {
	const task = { operation: "callees", request: { name: "wrong", file: "wrong.ts", direction: "dependents" } };
	const subject = { id: "seed", name: "entry", kind: "function", file: "src/entry.ts" };
	const node = { id: "callee", name: "helper", kind: "function", file: "src/helper.ts" };
	const facts = actualFacts(task, { operation: "callees", subject, nodes: [node], edges: [{ source: subject.id, target: node.id }] });
	assert.deepEqual(new Set(facts.files), new Set([subject.file, node.file]));
	assert.deepEqual(new Set(facts.symbols), new Set([subject.name, node.name]));
	assert.deepEqual(facts.edges, ["entry->helper"]);
	const fileSubject = { ...subject, kind: "file", name: "entry.ts" };
	for (const direction of ["imports", "dependents"]) {
		const dependency = actualFacts(task, { operation: "dependencies", direction, subject: fileSubject, files: [node.file] });
		assert.deepEqual(new Set(dependency.files), new Set([subject.file, node.file]));
		assert.deepEqual(dependency.symbols, []);
		assert.deepEqual(dependency.edges, direction === "imports" ? ["entry.ts->helper.ts"] : ["helper.ts->entry.ts"]);
	}
	assert.deepEqual(actualFacts(task, { operation: "dependencies", direction: "imports", files: [node.file] }).edges, []);
	assert.deepEqual(actualFacts(task, { operation: "dependencies", subject: fileSubject, files: [node.file] }).edges, []);
});

test("source baseline resolves dependency imports using bounded targeted reads", () => {
	const tasks = JSON.parse(readFileSync(groundTruthPath, "utf8")).tasks;
	const task = tasks.find((entry) => entry.id === "dependencies-orders-imports");
	assert.ok(task);
	const baseline = runTargetedTextBaseline(fixtureDirectory, task);
	assert.deepEqual(new Set(baseline.files), new Set(["src/orders.ts", "src/notifier.ts", "src/persistence.ts"]), JSON.stringify(baseline.transcript));
	assert.deepEqual(new Set(baseline.edges), new Set(["orders.ts->notifier.ts", "orders.ts->persistence.ts"]));
});

test("provisional performance targets remain frozen and not treated as release gates", () => {
	assert.match(frozenHypotheses.structuralRetrievalMedianPayloadReduction, />= 30%/);
	assert.match(frozenHypotheses.indexingEventLoopP95, /50 ms/);
});
