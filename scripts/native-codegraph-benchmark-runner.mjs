import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
	actualFacts,
	baselineFacts,
	fixtureDirectory,
	groundTruthPath,
	requireCandidateController,
	runtimeMetadata,
	shouldUseTextFallback,
	scoreFacts,
	sourceCounts,
	runTargetedTextBaseline,
	trackDirectory,
} from "./benchmark-native-codegraph.mjs";

const STARTUP_WARMUPS = 2;
const STARTUP_SAMPLES = 10;
const CLEAN_INDEX_RUNS = 3;
const QUERY_SAMPLES_PER_OPERATION = 30;
const MUTATION_SAMPLES = 20;
const READY_DEADLINE_MS = 120_000;
const MUTATION_DEADLINE_MS = 30_000;

function quantile(values, fraction) {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.max(0, Math.ceil(fraction * sorted.length) - 1)];
}

function summarize(values) {
	return { count: values.length, median: quantile(values, 0.5), p95: quantile(values, 0.95), min: Math.min(...values), max: Math.max(...values) };
}

function processFdCount() {
	try { return readdirSync("/proc/self/fd").length; } catch { return null; }
}

function directChildPids() {
	try {
		const path = `/proc/self/task/${process.pid}/children`;
		return readFileSync(path, "utf8").trim().split(/\s+/).filter(Boolean).map(Number);
	} catch { return []; }
}

function processStatus(pid) {
	try {
		const status = readFileSync(`/proc/${pid}/status`, "utf8");
		const rss = /^VmRSS:\s+(\d+)\s+kB/m.exec(status);
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		const fields = stat.slice(stat.lastIndexOf(")") + 2).split(/\s+/);
		return { pid, rssBytes: rss ? Number(rss[1]) * 1024 : 0, cpuTicks: Number(fields[11]) + Number(fields[12]) };
	} catch { return undefined; }
}

function createResourceSampler() {
	const histogram = monitorEventLoopDelay({ resolution: 10 });
	const hostCpu = process.cpuUsage();
	const childrenBefore = new Set(directChildPids());
	const observedChildren = new Set();
	const previousTicks = new Map();
	let childCpuTicks = 0;
	let peakChildRssBytes = 0;
	let peakHostRssBytes = process.memoryUsage.rss();
	histogram.enable();
	const timer = setInterval(() => {
		peakHostRssBytes = Math.max(peakHostRssBytes, process.memoryUsage.rss());
		for (const pid of directChildPids()) {
			const current = processStatus(pid);
			if (!current) continue;
			observedChildren.add(pid);
			peakChildRssBytes = Math.max(peakChildRssBytes, current.rssBytes);
			const previous = previousTicks.get(pid);
			if (previous !== undefined && current.cpuTicks >= previous) childCpuTicks += current.cpuTicks - previous;
			previousTicks.set(pid, current.cpuTicks);
		}
	}, 50);
	return () => {
		clearInterval(timer);
		histogram.disable();
		const hostCpuDelta = process.cpuUsage(hostCpu);
		const ticksPerSecond = Number(spawnSync("getconf", ["CLK_TCK"], { encoding: "utf8" }).stdout) || null;
		return {
			eventLoopDelayP95Ms: Number(histogram.percentile(95)) / 1e6,
			hostCpuMs: (hostCpuDelta.user + hostCpuDelta.system) / 1000,
			hostPeakRssBytes: peakHostRssBytes,
			engineWorkerObservedPids: [...observedChildren],
			engineWorkerCpuMs: ticksPerSecond ? childCpuTicks * 1000 / ticksPerSecond : null,
			engineWorkerPeakRssBytes: peakChildRssBytes || null,
			engineWorkerMetricsAvailable: observedChildren.size > 0 && ticksPerSecond !== null,
			childrenBefore: [...childrenBefore],
			childrenAfter: directChildPids(),
			fileDescriptorsAfter: processFdCount(),
			activeHandlesAfter: process._getActiveHandles?.().length ?? null,
		};
	};
}

function createCorpus(root, generatedFiles) {
	cpSync(fixtureDirectory, root, { recursive: true });
	for (let index = 0; index < generatedFiles; index++) {
		const id = String(index + 1).padStart(4, "0");
		if (index % 2 === 0) {
			const name = `replicaTs${id}`;
			const directory = join(root, "generated-ts");
			mkdirSync(directory, { recursive: true });
			writeFileSync(join(directory, `${name}.ts`), `export function ${name}(value: string): string {\n  return value.trim().toLowerCase();\n}\n`);
		} else {
			const name = `replicaPy${id}`;
			const directory = join(root, "generated-python");
			mkdirSync(directory, { recursive: true });
			writeFileSync(join(directory, `${name}.py`), `def ${name}(value: str) -> str:\n    return value.strip().lower()\n`);
		}
	}
}

function seedWatcherFiles(root) {
	const directory = join(root, "watch-fixtures");
	mkdirSync(directory, { recursive: true });
	for (let index = 1; index <= 5; index++) {
		const id = String(index).padStart(2, "0");
		writeFileSync(join(directory, `edit-${id}.ts`), `export function beforeEdit${id}(): string { return "before"; }\n`);
		writeFileSync(join(directory, `delete-${id}.ts`), `export function deleteTarget${id}(): string { return "delete"; }\n`);
		writeFileSync(join(directory, `rename-${id}.ts`), `export function renameTarget${id}(): string { return "rename"; }\n`);
	}
}

async function waitUntilReady(service, label, statusLatencies = []) {
	const deadline = Date.now() + READY_DEADLINE_MS;
	let started = performance.now();
	let last = service.status();
	statusLatencies.push(performance.now() - started);
	while (Date.now() < deadline) {
		started = performance.now();
		last = service.status();
		statusLatencies.push(performance.now() - started);
		if (last.state === "ready" && last.freshness === "current" && last.revision) return last;
		if (["error", "disposed"].includes(last.state)) break;
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 30));
	}
	throw new Error(`${label} readiness deadline expired (${READY_DEADLINE_MS} ms): ${JSON.stringify(last)}`);
}

async function openReady(acquireCodegraph, root, watch = false) {
	const started = performance.now();
	const service = acquireCodegraph({ cwd: root, grant: { root }, settings: { enabled: true, watch, debounceMs: 250 } });
	const acquireToReturnMs = performance.now() - started;
	const statusLatencies = [];
	try {
		const status = await waitUntilReady(service, "CodeGraph index", statusLatencies);
		return { service, status, acquireToReturnMs, acquireToReadyMs: performance.now() - started, statusLatencies };
	} catch (error) {
		await dispose(service);
		throw error;
	}
}

async function dispose(service) {
	service.dispose();
	await service.disposed;
}

async function waitForOwnedChildrenToExit(children, label) {
	const deadline = Date.now() + 5_000;
	while (Date.now() < deadline) {
		const stillRunning = directChildPids().filter((pid) => children.includes(pid));
		if (stillRunning.length === 0) return;
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
	}
	throw new Error(`${label} left owned child processes alive: ${JSON.stringify(directChildPids().filter((pid) => children.includes(pid)))}`);
}

async function sampleStartup(acquireCodegraph, root, condition, measured) {
	if (condition === "cold") rmSync(join(root, ".codegraph"), { recursive: true, force: true });
	const sampler = condition === "cold" ? createResourceSampler() : undefined;
	const childrenBefore = new Set(directChildPids());
	const started = performance.now();
	const service = acquireCodegraph({
		cwd: root,
		grant: { root },
		settings: { enabled: condition !== "disabled", watch: false },
	});
	const acquireToReturnMs = performance.now() - started;
	const statusLatencies = [];
	try {
		let acquireToReadyMs = acquireToReturnMs;
		let statusStarted = performance.now();
		let status = service.status();
		statusLatencies.push(performance.now() - statusStarted);
		if (condition !== "disabled") {
			status = await waitUntilReady(service, `${condition} startup`, statusLatencies);
			acquireToReadyMs = performance.now() - started;
		}
		const metrics = sampler?.();
		await dispose(service);
		const ownedChildren = directChildPids().filter((pid) => !childrenBefore.has(pid));
		await waitForOwnedChildrenToExit(ownedChildren, `${condition} startup`);
		const cleanup = { ownedChildren, fileDescriptors: processFdCount(), activeHandles: process._getActiveHandles?.().length ?? null };
		return { condition, measured, acquireToReturnMs, acquireToReadyMs, status, statusCalls: statusLatencies.length, statusP95Ms: quantile(statusLatencies, 0.95), cleanup, ...(metrics ? { metrics } : {}) };
	} catch (error) {
		sampler?.();
		await dispose(service);
		throw error;
	}
}

async function measureStartupConditions(acquireCodegraph, root) {
	const rows = [];
	for (const condition of ["disabled", "cold"]) {
		for (let index = 0; index < STARTUP_WARMUPS + STARTUP_SAMPLES; index++) {
			rows.push(await sampleStartup(acquireCodegraph, root, condition, index >= STARTUP_WARMUPS));
		}
	}
	await sampleStartup(acquireCodegraph, root, "cold", false);
	for (let index = 0; index < STARTUP_WARMUPS + STARTUP_SAMPLES; index++) {
		rows.push(await sampleStartup(acquireCodegraph, root, "warm", index >= STARTUP_WARMUPS));
	}
	return rows;
}

async function measureCleanIndexes(acquireCodegraph, root, corpus) {
	const rows = [];
	for (let index = 0; index < CLEAN_INDEX_RUNS; index++) {
		rmSync(join(root, ".codegraph"), { recursive: true, force: true });
		const childrenBefore = new Set(directChildPids());
		const sampler = createResourceSampler();
		let opened;
		try {
			opened = await openReady(acquireCodegraph, root);
			const metrics = sampler();
			const diskBytes = listBytes(join(root, ".codegraph"));
			await dispose(opened.service);
			const ownedChildren = directChildPids().filter((pid) => !childrenBefore.has(pid));
			await waitForOwnedChildrenToExit(ownedChildren, `${corpus} clean-index sample ${index + 1}`);
			rows.push({ corpus, sample: index + 1, wallMs: opened.acquireToReadyMs, status: opened.status, statusCalls: opened.statusLatencies.length, statusP95Ms: quantile(opened.statusLatencies, 0.95), metrics, diskBytes, cleanup: { ownedChildren, fileDescriptors: processFdCount(), activeHandles: process._getActiveHandles?.().length ?? null } });
		} catch (error) {
			sampler();
			if (opened) await dispose(opened.service);
			throw error;
		}
	}
	return rows;
}

function listBytes(directory) {
	let size = 0;
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) size += listBytes(path);
		else if (entry.isFile()) size += readFileSync(path).byteLength;
	}
	return size;
}

async function runQueries(service, root, tasks, corpus) {
	const rows = [];
	for (const operation of ["search", "symbols", "callers", "callees", "dependencies", "impact", "context"]) {
		const cases = tasks.filter((task) => task.operation === operation);
		for (let sample = 0; sample < QUERY_SAMPLES_PER_OPERATION; sample++) {
			const task = cases[sample % cases.length];
			const baselineStart = performance.now();
			const baseline = runTargetedTextBaseline(root, task);
			const baselineMs = performance.now() - baselineStart;
			const queryStart = performance.now();
			const result = await service.query(task.request);
			const queryMs = performance.now() - queryStart;
			const actual = actualFacts(task, result);
			const directFileScore = scoreFacts(task.expected.files, actual.files);
			const directSymbolScore = scoreFacts(task.expected.symbols, actual.symbols);
			const directEdgeScore = scoreFacts(task.expected.edges, actual.edges);
			let fallback;
			let fallbackMs = 0;
			if (shouldUseTextFallback(task, result)) {
				const fallbackStart = performance.now();
				fallback = runTargetedTextBaseline(root, task);
				fallbackMs = performance.now() - fallbackStart;
			}
			if (fallback) {
				const fallbackFacts = baselineFacts(task, fallback);
				actual.files = [...new Set([...actual.files, ...fallbackFacts.files])];
				actual.symbols = [...new Set([...actual.symbols, ...fallbackFacts.symbols])];
				actual.edges = [...new Set([...actual.edges, ...fallbackFacts.edges])];
			}
			const baselineActual = baselineFacts(task, baseline);
			rows.push({
				corpus,
				task: task.id,
				operation,
				sample: sample + 1,
				candidateStatus: result.status,
				candidateMs: queryMs,
				candidateFallback: Boolean(fallback),
				candidateFallbackMs: fallbackMs,
				candidateBytes: Buffer.byteLength(JSON.stringify(result), "utf8") + (fallback?.bytes ?? 0),
				candidateCalls: 1 + (fallback?.calls ?? 0),
				baselineMs,
				baselineBytes: baseline.bytes,
				baselineCalls: baseline.calls,
				baselineLinesRead: baseline.linesRead,
				directFileScore,
				directSymbolScore,
				directEdgeScore,
				fileScore: scoreFacts(task.expected.files, actual.files),
				symbolScore: scoreFacts(task.expected.symbols, actual.symbols),
				edgeScore: scoreFacts(task.expected.edges, actual.edges),
				baselineFileScore: scoreFacts(task.expected.files, baselineActual.files),
				baselineSymbolScore: scoreFacts(task.expected.symbols, baselineActual.symbols),
				baselineEdgeScore: scoreFacts(task.expected.edges, baselineActual.edges),
				result,
				baseline: baseline.transcript,
			});
		}
	}
	return rows;
}

async function waitForMutation(service, predicate, label) {
	const deadline = Date.now() + MUTATION_DEADLINE_MS;
	let last = service.status();
	while (Date.now() < deadline) {
		last = service.status();
		const result = await service.query({ operation: "search", query: predicate.query });
		if (last.freshness === "current" && predicate.check(result)) return result;
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 40));
	}
	throw new Error(`${label} did not become visible within ${MUTATION_DEADLINE_MS} ms; last status ${JSON.stringify(last)}`);
}

async function measureMutations(acquireCodegraph, root) {
	seedWatcherFiles(root);
	const childrenBefore = new Set(directChildPids());
	const opened = await openReady(acquireCodegraph, root, true);
	const ownedChildren = directChildPids().filter((pid) => !childrenBefore.has(pid));
	const service = opened.service;
	let idleSampler;
	try {
	const rows = [];
	const directory = join(root, "watch-fixtures");
	const startedIdle = performance.now();
	idleSampler = createResourceSampler();
	await new Promise((resolvePromise) => setTimeout(resolvePromise, 2_000));
	const idleMetrics = idleSampler();
	idleSampler = undefined;
	const idleMs = performance.now() - startedIdle;
	for (let index = 1; index <= 5; index++) {
		const id = String(index).padStart(2, "0");
		const addName = `addedTarget${id}`;
		let start = performance.now();
		writeFileSync(join(directory, `add-${id}.ts`), `export function ${addName}(): string { return "added"; }\n`);
		await waitForMutation(service, { query: addName, check: (result) => result.nodes.some((node) => node.name === addName) }, `add ${id}`);
		rows.push({ operation: "add", index, latencyMs: performance.now() - start });

		const oldEdit = `beforeEdit${id}`;
		const newEdit = `afterEdit${id}`;
		start = performance.now();
		writeFileSync(join(directory, `edit-${id}.ts`), `export function ${newEdit}(): string { return "after"; }\n`);
		await waitForMutation(service, { query: newEdit, check: (result) => result.nodes.some((node) => node.name === newEdit) && !result.nodes.some((node) => node.name === oldEdit) }, `edit ${id}`);
		rows.push({ operation: "edit", index, latencyMs: performance.now() - start, oldSymbol: oldEdit, newSymbol: newEdit });

		const deleteName = `deleteTarget${id}`;
		start = performance.now();
		unlinkSync(join(directory, `delete-${id}.ts`));
		await waitForMutation(service, { query: deleteName, check: (result) => !result.nodes.some((node) => node.name === deleteName) }, `delete ${id}`);
		rows.push({ operation: "delete", index, latencyMs: performance.now() - start });

		const renameName = `renameTarget${id}`;
		start = performance.now();
		renameSync(join(directory, `rename-${id}.ts`), join(directory, `renamed-${id}.ts`));
		await waitForMutation(service, { query: renameName, check: (result) => result.nodes.some((node) => node.name === renameName && node.file === `watch-fixtures/renamed-${id}.ts`) && !result.nodes.some((node) => node.name === renameName && node.file === `watch-fixtures/rename-${id}.ts`) }, `rename ${id}`);
		rows.push({ operation: "rename", index, latencyMs: performance.now() - start });
	}
	const status = service.status();
	await dispose(service);
	await waitForOwnedChildrenToExit(ownedChildren, "watcher mutation run");
	return { rows, status, idle: { intervalMs: idleMs, hostCpuMs: idleMetrics.hostCpuMs, engineWorkerCpuMs: idleMetrics.engineWorkerCpuMs, engineWorkerMetricsAvailable: idleMetrics.engineWorkerMetricsAvailable }, cleanup: { ownedChildren, fileDescriptors: processFdCount(), childrenStillRunning: directChildPids().filter((pid) => ownedChildren.includes(pid)) } };
	} finally {
		idleSampler?.();
		await dispose(service);
	}
}

function hypothesisStatus(value, target) {
	if (!Number.isFinite(value) || !Number.isFinite(target)) return { status: "NOT MEASURED", value, target };
	return { status: value <= target ? "MET" : "MISSED", value, target };
}

function summarizeQuality(rows, fileField, symbolField, edgeField) {
	const average = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
	const summarizeFact = (field) => ({
		recall: average(rows.map((row) => row[field].recall)),
		precision: average(rows.map((row) => row[field].precision)),
	});
	return {
		samples: rows.length,
		files: summarizeFact(fileField),
		symbols: summarizeFact(symbolField),
		edges: summarizeFact(edgeField),
		requiredEdgesComplete: rows.every((row) => row[edgeField].missing.length === 0),
	};
}

function writeArtifacts(report) {
	mkdirSync(join(trackDirectory, "raw"), { recursive: true });
	const stamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
	const jsonPath = join(trackDirectory, "raw", `full-benchmark-${stamp}.json`);
	const csvPath = join(trackDirectory, "raw", `full-benchmark-${stamp}.csv`);
	writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
	const rows = [
		...report.startup.map((row) => ({ type: "startup", corpus: "small", operation: row.condition, sample: row.measured, latencyMs: row.acquireToReadyMs, bytes: "", status: row.status.state })),
		...report.coldIndexes.map((row) => ({ type: "cold-index", corpus: row.corpus, operation: "index", sample: row.sample, latencyMs: row.wallMs, bytes: row.diskBytes, status: row.status.state })),
		...report.queries.map((row) => ({ type: "query", corpus: row.corpus, operation: row.operation, sample: row.sample, latencyMs: row.candidateMs, bytes: row.candidateBytes, status: row.candidateStatus })),
		...report.mutations.rows.map((row) => ({ type: "mutation", corpus: "medium", operation: row.operation, sample: row.index, latencyMs: row.latencyMs, bytes: "", status: "visible" })),
	];
	const columns = ["type", "corpus", "operation", "sample", "latencyMs", "bytes", "status"];
	const escape = (value) => `"${String(value ?? "").replaceAll('"', '""')}"`;
	writeFileSync(csvPath, [columns, ...rows.map((row) => columns.map((column) => row[column]))].map((row) => row.map(escape).join(",")).join("\n") + "\n");
	return { json: relative(dirname(fileURLToPath(import.meta.url)), jsonPath), csv: relative(dirname(fileURLToPath(import.meta.url)), csvPath) };
}

export async function runFullNativeCodegraphBenchmark() {
	const definition = JSON.parse(readFileSync(groundTruthPath, "utf8"));
	const runMetadata = runtimeMetadata();
	const acquireCodegraph = await requireCandidateController();
	const owned = mkdtempSync(join(tmpdir(), "pi-codegraph-benchmark-"));
	try {
	const small = join(owned, "small");
	createCorpus(small, 0);
	const startup = await measureStartupConditions(acquireCodegraph, small);
	const corpusSpecs = [
		{ name: "small", generatedFiles: 0, root: small },
		{ name: "medium", generatedFiles: 100, root: join(owned, "medium") },
		{ name: "large", generatedFiles: 1_000, root: join(owned, "large") },
	];
	createCorpus(corpusSpecs[1].root, corpusSpecs[1].generatedFiles);
	createCorpus(corpusSpecs[2].root, corpusSpecs[2].generatedFiles);
	seedWatcherFiles(corpusSpecs[1].root);
	const corpusCounts = Object.fromEntries(corpusSpecs.map((corpus) => [corpus.name, sourceCounts(corpus.root)]));
	const coldIndexes = [];
	for (const corpus of corpusSpecs.slice(1)) coldIndexes.push(...await measureCleanIndexes(acquireCodegraph, corpus.root, corpus.name));
	const queries = [];
	for (const corpus of corpusSpecs) {
		const opened = await openReady(acquireCodegraph, corpus.root);
		try {
			queries.push(...await runQueries(opened.service, corpus.root, definition.tasks, corpus.name));
		} finally {
			await dispose(opened.service);
		}
	}
	const mutations = await measureMutations(acquireCodegraph, corpusSpecs[1].root);
	assert.equal(mutations.rows.length, MUTATION_SAMPLES, "mutation sample count must remain frozen");
	for (const corpus of corpusSpecs) {
		for (const operation of ["search", "symbols", "callers", "callees", "dependencies", "impact", "context"]) {
			assert.equal(queries.filter((row) => row.corpus === corpus.name && row.operation === operation).length, QUERY_SAMPLES_PER_OPERATION, `${corpus.name}/${operation} query count must remain frozen`);
		}
	}
	const measuredStartup = startup.filter((row) => row.measured);
	const disabled = measuredStartup.filter((row) => row.condition === "disabled");
	const warm = measuredStartup.filter((row) => row.condition === "warm");
	const warmMedianOverhead = quantile(warm.map((row) => row.acquireToReturnMs), 0.5) - quantile(disabled.map((row) => row.acquireToReturnMs), 0.5);
	const warmP95Overhead = quantile(warm.map((row) => row.acquireToReturnMs), 0.95) - quantile(disabled.map((row) => row.acquireToReturnMs), 0.95);
	const mediumQuerySamples = queries.filter((row) => row.corpus === "medium").map((row) => row.candidateMs);
	const mutationSamples = mutations.rows.map((row) => row.latencyMs);
	const allIndexDelaySamples = coldIndexes.flatMap((row) => [row.metrics.eventLoopDelayP95Ms]);
	const hypotheses = {
		warmStartupMedianOverhead: { status: "NOT MEASURED", serviceAcquireOverheadMs: warmMedianOverhead, reason: "Service acquire latency is not Pi TUI/RPC first-usable latency." },
		warmStartupP95Overhead: { status: "NOT MEASURED", serviceAcquireOverheadMs: warmP95Overhead, reason: "Service acquire latency is not Pi TUI/RPC first-usable latency." },
		indexingEventLoopP95: hypothesisStatus(Math.max(...allIndexDelaySamples), 50),
		mediumQueryP95: hypothesisStatus(quantile(mediumQuerySamples, 0.95), 250),
		mediumWatcherP95: hypothesisStatus(quantile(mutationSamples, 0.95), 2_250),
		structuralRetrievalPayloadReduction: { status: "NOT MEASURED", reason: "Provider tool definitions/guidance and duplicated serialized transport payload are not captured by service-level smoke." },
	};
	const serviceQueryQuality = Object.fromEntries(corpusSpecs.map((corpus) => {
		const rows = queries.filter((row) => row.corpus === corpus.name);
		return [corpus.name, {
			candidateDirect: summarizeQuality(rows, "directFileScore", "directSymbolScore", "directEdgeScore"),
			candidateWithFallback: summarizeQuality(rows, "fileScore", "symbolScore", "edgeScore"),
			baseline: summarizeQuality(rows, "baselineFileScore", "baselineSymbolScore", "baselineEdgeScore"),
		}];
	}));
	const taskQuality = Object.fromEntries(corpusSpecs.map((corpus) => {
		const perTask = definition.tasks.map((task) => {
			const rows = queries.filter((row) => row.corpus === corpus.name && row.task === task.id);
			return [task.id, {
				candidateDirect: summarizeQuality(rows, "directFileScore", "directSymbolScore", "directEdgeScore"),
				candidateWithFallback: summarizeQuality(rows, "fileScore", "symbolScore", "edgeScore"),
				baseline: summarizeQuality(rows, "baselineFileScore", "baselineSymbolScore", "baselineEdgeScore"),
			}];
		});
		return [corpus.name, Object.fromEntries(perTask)];
	}));
	const fallbackLimitedTask = (task) => /literal|missing|ambiguous|paraphrase/.test(task.id);
	const structuralDirectEdgeMisses = queries.flatMap((row) => {
		const task = definition.tasks.find((candidate) => candidate.id === row.task);
		return task && !fallbackLimitedTask(task) ? row.directEdgeScore.missing.map((edge) => ({ corpus: row.corpus, task: row.task, edge })) : [];
	});
	const workflowFactMisses = queries.flatMap((row) => [
		...row.fileScore.missing.map((fact) => ({ corpus: row.corpus, task: row.task, type: "file", fact })),
		...row.symbolScore.missing.map((fact) => ({ corpus: row.corpus, task: row.task, type: "symbol", fact })),
		...row.edgeScore.missing.map((fact) => ({ corpus: row.corpus, task: row.task, type: "edge", fact })),
	]);
	const qualityGate = {
		candidateWorkflowAllFrozenFactsComplete: workflowFactMisses.length === 0,
		candidateStructuralDirectEdgesComplete: structuralDirectEdgeMisses.length === 0,
		workflowFactMisses,
		structuralDirectEdgeMisses,
	};
	const report = {
		status: "FULL_SOURCE_SERVICE_BENCHMARK_NOT_PACKAGE_PROOF",
		qualityGate,
		metadata: runMetadata,
		protocol: { startupWarmups: STARTUP_WARMUPS, startupSamplesPerCondition: STARTUP_SAMPLES, cleanMediumLargeIndexes: CLEAN_INDEX_RUNS, querySamplesPerOperationCorpus: QUERY_SAMPLES_PER_OPERATION, watcherMutations: MUTATION_SAMPLES, percentile: "nearest-rank ceil(p*n), one-based", readinessDeadlineMs: READY_DEADLINE_MS, mutationDeadlineMs: MUTATION_DEADLINE_MS },
		corpora: corpusCounts,
		startup: startup.map(({ status, ...row }) => ({ ...row, status: { state: status.state, freshness: status.freshness, partial: status.partial, watcher: status.watcher, counts: status.counts, revision: status.revision, lastError: status.lastError } })),
		coldIndexes,
		queries,
		retrievalQuality: { byCorpus: serviceQueryQuality, byTask: taskQuality, bytesSavings: "NOT MEASURED; excludes provider definitions/guidance and duplicate transport payload" },
		mutations,
		summaries: {
			startup: Object.fromEntries(["disabled", "cold", "warm"].map((condition) => [condition, summarize(measuredStartup.filter((row) => row.condition === condition).map((row) => row.acquireToReadyMs))])),
			coldIndexes: Object.fromEntries(corpusSpecs.slice(1).map((corpus) => [corpus.name, summarize(coldIndexes.filter((row) => row.corpus === corpus.name).map((row) => row.wallMs))])),
			queries: Object.fromEntries(corpusSpecs.map((corpus) => [corpus.name, Object.fromEntries(["search", "symbols", "callers", "callees", "dependencies", "impact", "context"].map((operation) => [operation, summarize(queries.filter((row) => row.corpus === corpus.name && row.operation === operation).map((row) => row.candidateMs))]))])),
			watcherLatency: summarize(mutationSamples),
		},
		hypotheses,
		limitations: ["Service-level payload counts exclude complete provider-visible tool definitions/guidance and transport duplication; no savings hypothesis scored.", "bytes/4 is not actual tokenization; no compatible tokenizer was validated.", "Host CPU/RSS are measured. Child worker CPU/RSS are sampled from /proc when available; Windows/macOS worker-level metrics may be unavailable.", "No real TUI/RPC first-usable measurement or production-installed artifact is included in source benchmark."],
	};
	const artifacts = writeArtifacts(report);
	return { ...report, artifacts };
	} finally {
		rmSync(owned, { recursive: true, force: true });
	}
}
