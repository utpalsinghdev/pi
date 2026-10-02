#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cpSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { cpus, release as osRelease, tmpdir, totalmem, type as osType } from "node:os";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { acquireCodegraph } from "../packages/coding-agent/src/core/codegraph/controller.ts";
import { runFullNativeCodegraphBenchmark } from "./native-codegraph-benchmark-runner.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const trackDirectory = join(repo, "docs/native-codegraph-artifacts/track-c");
export const fixtureDirectory = join(trackDirectory, "fixtures");
export const groundTruthPath = join(trackDirectory, "ground-truth.json");

const expectedOperations = new Set(["search", "symbols", "callers", "callees", "dependencies", "impact", "context"]);
export const frozenHypotheses = {
	warmStartupMedianOverhead: "<= max(100 ms, 10% of disabled median)",
	warmStartupP95Overhead: "<= max(200 ms, 20% of disabled p95)",
	indexingEventLoopP95: "<= 50 ms",
	mediumQueryP95: "<= 250 ms",
	mediumWatcherP95: "<= configured debounce + 2 seconds",
	structuralRetrievalMedianPayloadReduction: ">= 30%",
};

function listFiles(directory) {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const path = join(directory, entry.name);
		return entry.isDirectory() ? listFiles(path) : entry.isFile() ? [path] : [];
	}).sort();
}

function sha256(path) {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function validateGroundTruth() {
	const definition = JSON.parse(readFileSync(groundTruthPath, "utf8"));
	assert.equal(definition.schemaVersion, 1, "unsupported ground-truth schema");
	assert.equal(definition.frozenBeforeCandidateRuns, true, "freeze ground truth before candidate measurements");
	assert.ok(definition.tasks.length >= 12, "at least 12 ground-truth tasks required");
	const ids = new Set();
	const operations = new Set();
	const sources = listFiles(fixtureDirectory);
	const sourceRelative = new Set(sources.map((path) => relative(fixtureDirectory, path).split(sep).join("/")));
	for (const task of definition.tasks) {
		assert.ok(!ids.has(task.id), `duplicate task id: ${task.id}`);
		ids.add(task.id);
		assert.ok(expectedOperations.has(task.operation), `unknown operation in ${task.id}: ${task.operation}`);
		assert.equal(task.request.operation, task.operation, `task/request operation mismatch: ${task.id}`);
		operations.add(task.operation);
		assert.ok(Array.isArray(task.expected.files) && Array.isArray(task.expected.symbols) && Array.isArray(task.expected.edges), `incomplete expected facts: ${task.id}`);
		assert.ok(task.evidence.length > 0, `missing independent evidence: ${task.id}`);
		for (const evidence of task.evidence) {
			if (evidence.startsWith("absent:")) {
				const needle = evidence.slice("absent:".length);
				assert.ok(sources.every((path) => !readFileSync(path, "utf8").includes(needle)), `${task.id} absence evidence found: ${needle}`);
				continue;
			}
			const separator = evidence.indexOf(":");
			assert.ok(separator > 0, `${task.id} evidence must be path:exact source substring`);
			const path = evidence.slice(0, separator);
			const snippet = evidence.slice(separator + 1);
			assert.ok(sourceRelative.has(path), `${task.id} evidence references missing file: ${path}`);
			assert.ok(readFileSync(join(fixtureDirectory, path), "utf8").includes(snippet), `${task.id} source evidence not found in ${path}: ${snippet}`);
		}
		for (const file of task.expected.files) assert.ok(sourceRelative.has(file), `${task.id} expects missing file ${file}`);
		for (const edge of task.expected.edges) assert.match(edge, /^[^\s]+->[^\s]+$/, `${task.id} edge must name direct relation`);
	}
	for (const operation of expectedOperations) assert.ok(operations.has(operation), `missing operation coverage: ${operation}`);
	assert.ok(definition.limitations.length >= 4, "limitations must be explicit");
	return { definition, sources };
}

export function sourceCounts(root) {
	let lines = 0;
	let bytes = 0;
	const extensions = {};
	for (const path of listFiles(root)) {
		const relativePath = relative(root, path).split(sep).join("/");
		if (relativePath === "codegraph.json" || relativePath.startsWith(".codegraph/")) continue;
		const info = lstatSync(path);
		assert.ok(info.isFile() && !info.isSymbolicLink(), `corpus contains non-regular file: ${path}`);
		const content = readFileSync(path);
		bytes += content.byteLength;
		lines += content.toString("utf8").split("\n").length - (content.byteLength === 0 ? 1 : 0);
		const extension = extname(path) || "<none>";
		extensions[extension] = (extensions[extension] ?? 0) + 1;
	}
	return { files: Object.values(extensions).reduce((sum, count) => sum + count, 0), lines, bytes, extensions };
}

export function validateFixtures() {
	const { definition, sources } = validateGroundTruth();
	const counts = sourceCounts(fixtureDirectory);
	const manifest = {
		fixtureRoot: relative(repo, fixtureDirectory),
		files: counts.files,
		lines: counts.lines,
		bytes: counts.bytes,
		extensions: counts.extensions,
		fixtureSha256: Object.fromEntries(sources.map((path) => [relative(fixtureDirectory, path).split(sep).join("/"), sha256(path)])),
		groundTruthSha256: sha256(groundTruthPath),
		tasks: definition.tasks.length,
		operations: [...new Set(definition.tasks.map((task) => task.operation))].sort(),
		hypothesesFrozen: frozenHypotheses,
		limitations: definition.limitations,
	};
	return manifest;
}

export function requireCandidateController() {
	assert.equal(typeof acquireCodegraph, "function", "controller must export acquireCodegraph(options)");
	return acquireCodegraph;
}

export function runtimeMetadata() {
	const node = process.versions.node;
	const packageLock = JSON.parse(readFileSync(join(repo, "package-lock.json"), "utf8"));
	const dependency = packageLock.packages?.["node_modules/@colbymchenry/codegraph"];
	const git = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" });
	const diff = spawnSync("git", ["diff", "--binary"], { cwd: repo, encoding: "buffer" });
	const staged = spawnSync("git", ["diff", "--cached", "--binary"], { cwd: repo, encoding: "buffer" });
	const status = spawnSync("git", ["status", "--short"], { cwd: repo, encoding: "utf8" });
	const diffState = Buffer.concat([Buffer.from(status.stdout ?? ""), diff.stdout ?? Buffer.alloc(0), staged.stdout ?? Buffer.alloc(0)]);
	return {
		sha: git.status === 0 ? git.stdout.trim() : null,
		diffState: status.status === 0 ? status.stdout.trim().split(/\r?\n/).filter(Boolean) : [],
		diffStateSha256: status.status === 0 && diff.status === 0 && staged.status === 0 ? createHash("sha256").update(diffState).digest("hex") : null,
		node,
		codegraphVersion: dependency?.version ?? null,
		platform: `${process.platform}/${process.arch}`,
		os: `${osType()} ${osRelease()}`,
		cpu: cpus()[0]?.model ?? "unknown",
		logicalCpuCount: cpus().length,
		ramBytes: totalmem(),
		runtime: process.execPath,
		harnessSha256: {
			entrypoint: sha256(fileURLToPath(import.meta.url)),
			runner: sha256(join(repo, "scripts/native-codegraph-benchmark-runner.mjs")),
			groundTruth: sha256(groundTruthPath),
		},
		candidateSourcesSha256: Object.fromEntries([
			"packages/coding-agent/src/core/codegraph/controller.ts",
			"packages/coding-agent/src/core/codegraph/worker.mjs",
			"packages/coding-agent/src/core/codegraph/types.ts",
			"packages/coding-agent/src/core/codegraph/format.ts",
			"packages/coding-agent/src/core/tools/codebase.ts",
			"packages/coding-agent/src/core/sdk.ts",
			"packages/coding-agent/src/core/agent-session.ts",
			"packages/coding-agent/src/config.ts",
		].map((path) => [path, sha256(join(repo, path))])),
	};
}

export function reportReadiness(status, description) {
	if (!status || !["ready", "degraded"].includes(status.state) || !status.revision || status.freshness === "unavailable") {
		throw new Error(`${description} failed readiness: ${JSON.stringify(status)}`);
	}
}

function queryTerms(task) {
	const raw = task.request.query ?? task.request.name ?? (task.request.file ? "." : "");
	if (task.operation === "dependencies" && task.request.file) {
		return task.request.direction === "dependents"
			? [basename(task.request.file).replace(/\.[^.]+$/, "")]
			: ["\\b(?:import|from|require)\\b"];
	}
	const terms = [...new Set(raw.split(/[^A-Za-z0-9_]+/).filter((term) => term.length > 2))];
	for (const term of [...terms]) {
		if (term.length > 4 && term.endsWith("s")) terms.push(term.slice(0, -1));
		if (term.length > 5 && term.endsWith("ed")) terms.push(term.slice(0, -2));
	}
	return terms.length > 0 ? [...new Set(terms)] : [raw];
}

export function runTargetedTextBaseline(root, task) {
	const terms = queryTerms(task);
	const searchCommands = [];
	const search = (searchTerms, searchTarget) => {
		const expression = searchTerms.length === 1 && searchTerms[0].startsWith("\\b")
			? searchTerms[0]
			: `(?:${searchTerms.join("|")})`;
		const command = spawnSync("rg", ["--line-number", "--no-heading", "--with-filename", "--hidden", "--glob", "!.codegraph/**", "--glob", "!codegraph.json", "-i", "-e", expression, searchTarget], { cwd: root, encoding: "utf8", maxBuffer: 1_000_000 });
		if (command.error) throw command.error;
		if (command.status !== 0 && command.status !== 1) throw new Error(`rg baseline failed (${command.status}): ${command.stderr}`);
		searchCommands.push(["rg", ...searchTerms, searchTarget]);
		return command.stdout.split(/\r?\n/).filter(Boolean).slice(0, 40).flatMap((line) => {
			const match = /^(.*?):(\d+):(.*)$/.exec(line);
			return match ? [{ file: relative(root, match[1]).split(sep).join("/"), line: Number(match[2]), text: match[3] }] : [];
		});
	};
	const target = task.request.file && !(task.operation === "dependencies" && task.request.direction === "dependents")
		? join(root, task.request.file)
		: root;
	let matches = search(terms, target);
	const buildWindows = (foundMatches) => {
		const windows = new Map();
		const hitsByFile = new Map();
		for (const match of foundMatches) {
			const fileMatches = hitsByFile.get(match.file) ?? [];
			fileMatches.push(match);
			hitsByFile.set(match.file, fileMatches);
		}
		for (const [file, fileMatches] of hitsByFile) {
			const sourceLines = readFileSync(join(root, file), "utf8").split(/\r?\n/);
			const ranges = [];
			for (const match of fileMatches) {
				const start = Math.max(1, match.line - 5);
				const end = Math.min(sourceLines.length, match.line + 5);
				const previous = ranges[ranges.length - 1];
				if (previous && start <= previous.endLine + 1) previous.endLine = Math.max(previous.endLine, end);
				else ranges.push({ startLine: start, endLine: end });
			}
			for (const range of ranges) {
				const key = `${file}:${range.startLine}`;
				windows.set(key, { file, startLine: range.startLine, lines: sourceLines.slice(range.startLine - 1, range.endLine) });
			}
		}
		return windows;
	};
	let windows = buildWindows(matches);
	if (task.operation === "callees" || task.operation === "impact") {
		const directRelations = [];
		for (const window of windows.values()) {
			let caller;
			for (const line of window.lines) {
				const declaration = /\b(?:function|def)\s+([A-Za-z_$][\w$]*)/.exec(line);
				if (declaration) caller = declaration[1];
				if (!caller) continue;
				for (const call of line.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)) {
					if (call[1] !== caller && !["if", "for", "while", "return"].includes(call[1])) directRelations.push(`${caller}->${call[1]}`);
				}
			}
		}
		const lookupNames = task.operation === "callees"
			? directRelations.filter((edge) => edge.startsWith(`${task.request.name}->`)).map((edge) => edge.split("->")[1])
			: directRelations.filter((edge) => edge.endsWith(`->${task.request.name}`)).map((edge) => edge.split("->")[0]);
		for (const name of new Set(lookupNames)) matches.push(...search([name], root));
		windows = buildWindows(matches);
	}
	const edges = [];
	if (task.operation === "dependencies" && task.request.file) {
		const targetStem = basename(task.request.file).replace(/\.[^.]+$/, "");
		const resolveImport = (fromFile, specifier) => {
			const base = resolve(root, dirname(fromFile), specifier);
			const candidates = [base, base.replace(/\.(?:m?js|cjs)$/, ".ts"), `${base}.ts`, `${base}.tsx`, `${base}.py`, join(base, "index.ts")];
			for (const candidate of candidates) {
				try {
					if (statSync(candidate).isFile()) return relative(root, candidate).split(sep).join("/");
				} catch {}
			}
			return undefined;
		};
		if (task.request.direction === "dependents") {
			for (const match of matches) {
				const content = readFileSync(join(root, match.file), "utf8");
				const imported = [...content.matchAll(/(?:from\s*|import\s*)["']([^"']+)["']/g)].map((item) => item[1]);
				if (imported.some((specifier) => basename(resolveImport(match.file, specifier) ?? specifier).replace(/\.[^.]+$/, "") === targetStem)) {
					edges.push(`${basename(match.file)}->${basename(task.request.file)}`);
				}
			}
			if (![...windows.values()].some((window) => window.file === task.request.file)) {
				const lines = readFileSync(join(root, task.request.file), "utf8").split(/\r?\n/);
				windows.set(task.request.file, { file: task.request.file, startLine: 1, lines: lines.slice(0, 11) });
			}
		} else {
			const imports = [...readFileSync(join(root, task.request.file), "utf8").matchAll(/(?:from\s*|import\s*)["']([^"']+)["']/g)];
			for (const item of imports) {
				const importedFile = resolveImport(task.request.file, item[1]);
				if (!importedFile) continue;
				edges.push(`${basename(task.request.file)}->${basename(importedFile)}`);
				if (![...windows.values()].some((window) => window.file === importedFile)) {
					const lines = readFileSync(join(root, importedFile), "utf8").split(/\r?\n/);
					windows.set(importedFile, { file: importedFile, startLine: 1, lines: lines.slice(0, 11) });
				}
			}
		}
	}
	const transcript = { workflow: "rg targeted hits + bounded eleven-line windows + import-path/call-path resolution", commands: searchCommands, windows: [...windows.values()], edges };
	const text = JSON.stringify(transcript);
	const symbols = new Set();
	const foundEdges = new Set(edges);
	const excludedCalls = new Set(["if", "for", "while", "switch", "catch", "function", "def", "return"]);
	for (const window of windows.values()) {
		if (task.operation === "dependencies") continue;
		let currentFunction;
		for (const line of window.lines) {
			const declaration = /\b(?:function|def|class|interface|type|const|let|var)\s+([A-Za-z_$][\w$]*)/.exec(line);
			if (declaration) {
				symbols.add(declaration[1]);
				if (/\b(?:function|def)\b/.test(line)) currentFunction = declaration[1];
			}
			if (!currentFunction) continue;
			for (const call of line.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)) {
				if (!excludedCalls.has(call[1]) && call[1] !== currentFunction) foundEdges.add(`${currentFunction}->${call[1]}`);
			}
		}
	}
	return {
		transcript,
		files: [...new Set([...windows.values()].map((window) => window.file))],
		symbolText: [...windows.values()].flatMap((window) => window.lines).join("\n"),
		symbols: [...symbols],
		edges: [...foundEdges],
		bytes: Buffer.byteLength(text, "utf8"),
		characters: text.length,
		calls: searchCommands.length + windows.size,
		linesRead: [...windows.values()].reduce((sum, window) => sum + window.lines.length, 0),
	};
}

export function scoreFacts(expected, actual) {
	const expectedSet = new Set(expected);
	const actualSet = new Set(actual);
	const truePositives = [...actualSet].filter((fact) => expectedSet.has(fact)).length;
	return {
		recall: expectedSet.size === 0 ? 1 : truePositives / expectedSet.size,
		precision: actualSet.size === 0 ? (expectedSet.size === 0 ? 1 : 0) : truePositives / actualSet.size,
		missing: [...expectedSet].filter((fact) => !actualSet.has(fact)),
		unexpected: [...actualSet].filter((fact) => !expectedSet.has(fact)),
	};
}

// Query inputs are not evidence. Credit only returned nodes, files and resolved endpoints.
export function actualFacts(_task, result) {
	const nodes = [...(result.subject ? [result.subject] : []), ...(result.nodes ?? [])];
	const files = new Set([...(result.files ?? []), ...nodes.map((node) => node.file), ...(result.snippets ?? []).map((snippet) => snippet.file)]);
	const symbols = new Set(nodes.filter((node) => node.kind !== "file").map((node) => node.name));
	const nodeNames = new Map(nodes.map((node) => [node.id, node.name]));
	const edges = new Set((result.edges ?? []).map((edge) => {
		const source = nodeNames.get(edge.source);
		const target = nodeNames.get(edge.target);
		return source && target ? `${source}->${target}` : "";
	}).filter(Boolean));
	if (result.operation === "dependencies" && result.subject?.kind === "file" && ["imports", "dependents"].includes(result.direction)) {
		for (const file of result.files ?? []) {
			edges.add(result.direction === "dependents" ? `${basename(file)}->${basename(result.subject.file)}` : `${basename(result.subject.file)}->${basename(file)}`);
		}
	}
	return { files: [...files], symbols: [...symbols], edges: [...edges] };
}

export function baselineFacts(_task, baseline) {
	return { files: baseline.files, symbols: baseline.symbols, edges: baseline.edges };
}

export function shouldUseTextFallback(task, result) {
	return result.status !== "ok" || task.id.includes("literal") || ((task.operation === "search" || task.operation === "symbols") && result.nodes.length === 0);
}

async function awaitIndex(service, timeoutMs = 120_000) {
	const deadline = Date.now() + timeoutMs;
	let last = service.status();
	while (Date.now() < deadline) {
		last = service.status();
		if (last.state === "ready" && last.freshness === "current" && last.revision) return last;
		if (["error", "disposed"].includes(last.state)) break;
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 30));
	}
	throw new Error(`Index readiness deadline (${timeoutMs} ms) expired: ${JSON.stringify(last)}`);
}

function csvEscape(value) {
	return `"${String(value).replaceAll('"', '""')}"`;
}

async function runGroundTruthSmoke() {
	const { definition } = validateGroundTruth();
	const acquireCodegraph = await requireCandidateController();
	const temporaryRoot = mkdtempSync(join(tmpdir(), "pi-codegraph-ground-truth-"));
	const project = join(temporaryRoot, "project");
	cpSync(fixtureDirectory, project, { recursive: true });
	let service;
	const rows = [];
	const started = performance.now();
	let firstUsableMs;
	let acquireToReadyMs;
	try {
		service = acquireCodegraph({ cwd: project, grant: { root: project }, settings: { enabled: true, watch: false } });
		firstUsableMs = performance.now() - started;
		const readyStatus = await awaitIndex(service);
		acquireToReadyMs = performance.now() - started;
		for (const task of definition.tasks) {
			const baselineStart = performance.now();
			const baseline = runTargetedTextBaseline(project, task);
			const baselineMs = performance.now() - baselineStart;
			const candidateStart = performance.now();
			const result = await service.query(task.request);
			const candidateMs = performance.now() - candidateStart;
			const candidate = actualFacts(task, result);
			const fallbackStarted = performance.now();
			const fallback = shouldUseTextFallback(task, result) ? runTargetedTextBaseline(project, task) : undefined;
			if (fallback) {
				const fallbackResult = baselineFacts(task, fallback);
				candidate.files = [...new Set([...candidate.files, ...fallbackResult.files])];
				candidate.symbols = [...new Set([...candidate.symbols, ...fallbackResult.symbols])];
				candidate.edges = [...new Set([...candidate.edges, ...fallbackResult.edges])];
			}
			const candidatePayload = [JSON.stringify(result), ...(fallback ? [JSON.stringify(fallback.transcript)] : [])].join("\n");
			const sourceBaseline = baselineFacts(task, baseline);
			rows.push({
				task: task.id,
					operation: task.operation,
					class: /literal|missing|ambiguous|paraphrase/.test(task.id) ? "fallback-or-limit" : "structural",
					status: result.status,
					candidateMs,
					candidateFallbackMs: fallback ? performance.now() - fallbackStarted : 0,
					baselineMs,
					candidateBytes: Buffer.byteLength(candidatePayload, "utf8"),
					candidateCharacters: candidatePayload.length,
					candidateCalls: 1 + (fallback?.calls ?? 0),
					candidateFallback: fallback !== undefined,
					candidateFallbackFiles: fallback?.files ?? [],
					candidateFallbackLinesRead: fallback?.linesRead ?? 0,
					candidateFallbackTranscript: fallback?.transcript,
					baselineBytes: baseline.bytes,
					baselineCharacters: baseline.characters,
					baselineCalls: baseline.calls,
					baselineFiles: baseline.files,
					baselineLinesRead: baseline.linesRead,
					fileScore: scoreFacts(task.expected.files, candidate.files),
					symbolScore: scoreFacts(task.expected.symbols, candidate.symbols),
					edgeScore: scoreFacts(task.expected.edges, candidate.edges),
					baselineFileScore: scoreFacts(task.expected.files, sourceBaseline.files),
					baselineSymbolScore: scoreFacts(task.expected.symbols, sourceBaseline.symbols),
					baselineEdgeScore: scoreFacts(task.expected.edges, sourceBaseline.edges),
					result,
					baseline: baseline.transcript,
			});
		}
		const metadata = runtimeMetadata();
		const structural = rows.filter((row) => row.class === "structural");
		const report = {
			status: "ONE_PASS_GROUND_TRUTH_SMOKE_NOT_FULL_BENCHMARK",
			metadata,
			corpus: { name: "small-exact-fixture", ...sourceCounts(project), readyStatus },
			readiness: { acquireToReturnMs: firstUsableMs, acquireToReadyMs },
			accounting: "Candidate payload includes serialized result and any targeted fallback transcript; both workflows exclude provider tool definitions/guidance and duplicated transport payload. Bytes/4 is not tokens. No payload-reduction hypothesis scored.",
			percentileMethod: "No percentiles: one measured observation per frozen task.",
			counts: { tasks: rows.length, structuralTasks: structural.length, fallbackOrLimitTasks: rows.length - structural.length },
			recall: {
				candidateRequiredDirectEdgesComplete: rows.every((row) => row.edgeScore.missing.length === 0),
				candidateRecallByTask: rows.map(({ task, fileScore, symbolScore, edgeScore }) => ({ task, files: fileScore.recall, symbols: symbolScore.recall, edges: edgeScore.recall })),
			},
			rows,
		};
		mkdirSync(join(trackDirectory, "raw"), { recursive: true });
		const stamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
		const jsonPath = join(trackDirectory, "raw", `ground-truth-smoke-${stamp}.json`);
		const csvPath = join(trackDirectory, "raw", `ground-truth-smoke-${stamp}.csv`);
		writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
		const columns = ["task", "operation", "class", "status", "candidateMs", "candidateFallbackMs", "baselineMs", "candidateBytes", "candidateCharacters", "candidateCalls", "candidateFallback", "candidateFallbackFiles", "candidateFallbackLinesRead", "baselineBytes", "baselineCharacters", "baselineCalls", "baselineFiles", "baselineLinesRead", "fileRecall", "symbolRecall", "edgeRecall", "missingRequiredEdges"];
		const csvRows = rows.map((row) => [row.task, row.operation, row.class, row.status, row.candidateMs, row.candidateFallbackMs, row.baselineMs, row.candidateBytes, row.candidateCharacters, row.candidateCalls, row.candidateFallback, row.candidateFallbackFiles.join(";"), row.candidateFallbackLinesRead, row.baselineBytes, row.baselineCharacters, row.baselineCalls, row.baselineFiles.join(";"), row.baselineLinesRead, row.fileScore.recall, row.symbolScore.recall, row.edgeScore.recall, row.edgeScore.missing.join(";")]);
		writeFileSync(csvPath, [columns, ...csvRows].map((row) => row.map(csvEscape).join(",")).join("\n") + "\n");
		console.log(JSON.stringify({ ...report, rawJson: relative(repo, jsonPath), rawCsv: relative(repo, csvPath), rows: rows.map(({ result, baseline, ...row }) => row) }, null, 2));
	} finally {
		if (service) {
			service.dispose();
			await service.disposed;
		}
		rmSync(temporaryRoot, { recursive: true, force: true });
	}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		const args = new Set(process.argv.slice(2));
		if (args.size === 0 || args.has("--validate-fixtures")) {
			const validation = validateFixtures();
			console.log(JSON.stringify({ status: "PASS", ...validation }, null, 2));
		} else if (args.has("--ground-truth-smoke")) {
			await runGroundTruthSmoke();
		} else if (args.has("--run")) {
			const report = await runFullNativeCodegraphBenchmark();
			console.log(JSON.stringify(report, null, 2));
			if (!report.qualityGate.candidateWorkflowAllFrozenFactsComplete || !report.qualityGate.candidateStructuralDirectEdgesComplete) process.exitCode = 1;
		} else {
			throw new Error("Usage: node scripts/benchmark-native-codegraph.mjs [--validate-fixtures|--ground-truth-smoke|--run]");
		}
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
