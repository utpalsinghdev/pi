#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { cpus, totalmem, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

const repo = resolve(fileURLToPath(new URL("..", import.meta.url)));
const packageDir = join(repo, "packages/coding-agent");
const fixtureDir = join(repo, "docs/native-codegraph-artifacts/track-c/fixtures");
const artifactDir = join(repo, "docs/native-codegraph-artifacts/host");
const timeoutMs = 30_000;
const indexTimeoutMs = 120_000;
const startupWarmups = 2;
const startupSamples = 10;
const modes = {
	bundled: join(packageDir, "dist/bundle/cli.js"),
	unbundled: join(packageDir, "dist/cli.js"),
};

export function percentile(values, p) {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted.length ? sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)] : null;
}

export function summarize(values) {
	return { count: values.length, median: percentile(values, 0.5), p95: percentile(values, 0.95), samplesMs: values };
}

/** Preserve partial JSONL records across arbitrary stream chunk boundaries. */
export function createJsonlDecoder(onMessage, onError) {
	let pending = "";
	const decode = (chunk) => {
		pending += chunk;
		let newline;
		while ((newline = pending.indexOf("\n")) !== -1) {
			const line = pending.slice(0, newline).replace(/\r$/, "");
			pending = pending.slice(newline + 1);
			if (!line) continue;
			try { onMessage(JSON.parse(line)); }
			catch (error) { onError(new Error(`Invalid RPC JSONL line ${JSON.stringify(line)}: ${error}`)); }
		}
	};
	decode.finish = () => { if (pending.trim()) throw new Error(`Incomplete RPC JSONL record: ${pending}`); };
	return decode;
}

export function rpcResponseElapsed(message, requestId, startedAt, observedAt) {
	return message?.type === "response" && message.id === requestId && message.command === "get_state" && message.success
		? observedAt - startedAt
		: null;
}

export function isIndexReady(status) {
	return status?.state === "ready" && status?.enabled === true && status?.freshness === "current" && status?.partial === false;
}

function writeJson(path, value) {
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function sha256(path) {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function writeTrust(agentDir, root) {
	mkdirSync(agentDir, { recursive: true });
	writeJson(join(agentDir, "trust.json"), { [root]: true });
}

function writeSettings(agentDir, enabled) {
	writeJson(join(agentDir, "settings.json"), { codegraph: { enabled, watch: false } });
}

/** Pass only operational terminal/path variables; never inherit credentials or runtime injection variables. */
export function childEnvironment(agentDir) {
	const safeEnvironment = {};
	for (const key of ["PATH", "TERM", "COLORTERM", "LANG", "LC_ALL", "TMPDIR", "TMP", "TEMP", "SystemRoot", "WINDIR"]) {
		if (process.env[key] !== undefined) safeEnvironment[key] = process.env[key];
	}
	const isolatedHome = join(dirname(agentDir), "home");
	mkdirSync(isolatedHome, { recursive: true });
	return {
		...safeEnvironment,
		HOME: isolatedHome,
		USERPROFILE: isolatedHome,
		PI_CODING_AGENT_DIR: agentDir,
		PI_OFFLINE: "1",
		PI_SKIP_VERSION_CHECK: "1",
		NO_COLOR: "1",
	};
}

function processResources() {
	let fileDescriptors = null;
	let directChildren = [];
	try { fileDescriptors = readdirSync("/proc/self/fd").length; } catch {}
	try { directChildren = readFileSync(`/proc/self/task/${process.pid}/children`, "utf8").trim().split(/\s+/).filter(Boolean); } catch {}
	return { fileDescriptors, directChildren };
}

function baseArgs(mode, root) {
	const args = ["--no-session", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-tools", "--mode", mode];
	return { args, cwd: root };
}

async function runChild(cli, args, { cwd, env, input = "", timeout = timeoutMs } = {}) {
	return await new Promise((resolvePromise, reject) => {
		const child = spawn(process.execPath, [cli, ...args], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		let killTimer;
		const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); killTimer = setTimeout(() => child.kill("SIGKILL"), 1_000); }, timeout);
		child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
		child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
		child.once("error", (error) => { clearTimeout(timer); clearTimeout(killTimer); reject(error); });
		child.once("close", (code, signal) => {
			clearTimeout(timer);
			clearTimeout(killTimer);
			if (timedOut) reject(new Error(`CLI deadline ${timeout}ms exceeded; stdout=${stdout.slice(-1500)} stderr=${stderr.slice(-1500)}`));
			else resolvePromise({ code, signal, stdout, stderr });
		});
		child.stdin.end(input);
	});
}

function assertNoProviderActivity(text) {
	assert.doesNotMatch(text, /\b(agent_start|message_start|tool_execution_start|assistant_message_start)\b/, "slash command unexpectedly started an agent/provider turn");
}

function parseJsonEvents(stdout) {
	const events = [];
	const decode = createJsonlDecoder((message) => events.push(message), (error) => { throw error; });
	decode(stdout);
	decode.finish();
	return events;
}

async function verifyPrintMode(cli, mode, root, agentDir, command) {
	const setup = baseArgs(mode, root);
	const args = [...setup.args, "--print", command];
	const result = await runChild(cli, args, { cwd: root, env: childEnvironment(agentDir) });
	assert.equal(result.code, 0, `${mode} ${command}: ${result.stderr}`);
	assertNoProviderActivity(result.stdout);
	if (mode === "json") {
		const events = parseJsonEvents(result.stdout);
		const event = events.find((item) => item.type === "codegraph_result" && item.command === (command.endsWith("refresh") ? "refresh" : "status"));
		assert.ok(event, `missing framed codegraph_result event for ${command}`);
		assert.equal(event.status?.root, root);
	} else {
		assert.match(result.stdout, /CodeGraph (?:ready|indexing|starting|disabled)/);
		assert.match(result.stdout, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	}
	return { argv: args, code: result.code, stdout: result.stdout, stderr: result.stderr };
}

async function verifySdk(root, agentDir) {
	const sdkUrl = new URL("../packages/coding-agent/src/core/sdk.ts", import.meta.url).href;
	const sessionManagerUrl = new URL("../packages/coding-agent/src/core/session-manager.ts", import.meta.url).href;
	const source = `import { createAgentSession } from ${JSON.stringify(sdkUrl)};\nimport { SessionManager } from ${JSON.stringify(sessionManagerUrl)};\nconst { session } = await createAgentSession({ cwd: ${JSON.stringify(root)}, agentDir: ${JSON.stringify(agentDir)}, codegraph: { root: ${JSON.stringify(root)} }, sessionManager: SessionManager.inMemory(${JSON.stringify(root)}) });\ntry { const tool = session.agent.state.tools.find((item) => item.name === "codebase"); if (!tool) throw new Error("native codebase tool not registered"); let output; for (let attempt = 0; attempt < 120; attempt++) { output = await tool.execute("host-evidence", { operation: "symbols", file: "src/orders.ts", limit: 5 }); const data = JSON.parse(output.content[0].text); if (data.status === "ok") { console.log(JSON.stringify({ registered: true, executed: true, status: data.status, files: data.nodes.map((node) => node.file) })); break; } if (!["not_ready"].includes(data.status)) throw new Error(JSON.stringify(data)); await new Promise((resolve) => setTimeout(resolve, 250)); } } finally { await session.disposeAsync(); }`;
	const result = await runCommand(process.execPath, ["--input-type=module", "-e", source], { cwd: root, env: childEnvironment(agentDir), timeout: indexTimeoutMs });
	assert.equal(result.code, 0, `SDK native tool execution failed: ${result.stderr}`);
	const sdkResult = JSON.parse(result.stdout.trim());
	assert.equal(sdkResult.registered, true);
	assert.equal(sdkResult.executed, true);
	assert.ok(sdkResult.files.includes("src/orders.ts"), "native codebase tool returned no fixture symbols");
	return { ...sdkResult, evidence: "source SDK registration and live indexed fixture query" };
}

function startRpc(cli, root, agentDir, onMessage, onError) {
	const setup = baseArgs("rpc", root);
	const startedAt = performance.now();
	const child = spawn(process.execPath, [cli, ...setup.args], { cwd: root, env: childEnvironment(agentDir), stdio: ["pipe", "pipe", "pipe"] });
	let stdout = "";
	let stderr = "";
	const decoder = createJsonlDecoder(onMessage, onError);
	child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; decoder(chunk); });
	child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
	child.once("close", () => { try { decoder.finish(); } catch (error) { onError(error); } });
	return { child, setup, startedAt, get stdout() { return stdout; }, get stderr() { return stderr; } };
}

function boundedExit(child, label, timeout = 5_000) {
	return new Promise((resolvePromise, reject) => {
		let killTimer;
		const timer = setTimeout(() => {
			child.kill("SIGTERM");
			killTimer = setTimeout(() => child.kill("SIGKILL"), 1_000);
		}, timeout);
		const hardDeadline = setTimeout(() => reject(new Error(`${label} failed to exit after SIGTERM and SIGKILL`)), timeout + 2_000);
		child.once("error", (error) => { clearTimeout(timer); clearTimeout(killTimer); clearTimeout(hardDeadline); reject(error); });
		child.once("close", (code, signal) => { clearTimeout(timer); clearTimeout(killTimer); clearTimeout(hardDeadline); resolvePromise({ code, signal }); });
	});
}

async function withRpc(cli, root, agentDir, callback) {
	let fail;
	const messages = [];
	const listeners = new Set();
	const rpc = startRpc(cli, root, agentDir, (message) => { messages.push(message); for (const listener of listeners) listener(message); }, (error) => { fail = error; });
	const checkFailure = () => { if (fail) throw fail; };
	let id = 0;
	const request = async (type, fields = {}, predicate = (message, requestId) => message.type === "response" && message.id === requestId) => {
		const requestId = `host-${process.pid}-${++id}`;
		const startedAt = performance.now();
		const observed = await new Promise((resolvePromise, reject) => {
			const inspect = (message) => {
				try { checkFailure(); } catch (error) { clearTimeout(deadline); listeners.delete(inspect); reject(error); return; }
				const observedAt = performance.now();
				if (type === "get_state") {
					const elapsedMs = rpcResponseElapsed(message, requestId, startedAt, observedAt);
					if (elapsedMs !== null) { clearTimeout(deadline); listeners.delete(inspect); resolvePromise({ message, elapsedMs }); }
				} else if (predicate(message, requestId)) {
					clearTimeout(deadline);
					listeners.delete(inspect);
					resolvePromise({ message, elapsedMs: observedAt - startedAt });
				}
			};
			const deadline = setTimeout(() => { listeners.delete(inspect); reject(new Error(`RPC ${type} deadline; stdout=${rpc.stdout.slice(-1200)} stderr=${rpc.stderr.slice(-1200)}`)); }, timeoutMs);
			listeners.add(inspect);
			rpc.child.stdin.write(`${JSON.stringify({ id: requestId, type, ...fields })}\n`);
		});
		return observed;
	};
	const dispose = async () => {
		rpc.child.stdin.end();
		const exit = await boundedExit(rpc.child, "RPC process");
		assert.equal(exit.code, 0, `RPC process failed: ${rpc.stderr}`);
		checkFailure();
	};
	try {
		const first = await request("get_state");
		assert.equal(first.message.success, true, `RPC get_state failed: ${rpc.stderr}`);
		const value = await callback({ rpc, request, startedAt: rpc.startedAt, firstUsableMs: first.elapsedMs, messages });
		await dispose();
		return { value, stdout: rpc.stdout, stderr: rpc.stderr, argv: rpc.setup.args };
	} catch (error) {
		if (rpc.child.exitCode === null) { rpc.child.kill("SIGTERM"); await boundedExit(rpc.child, "RPC cleanup").catch(() => {}); }
		throw error;
	}
}

async function rpcStatus(request, root) {
	const { message } = await request("prompt", { message: "/codegraph status" }, (item) => item.type === "codegraph_result" && item.command === "status");
	assert.equal(message.status?.root, root);
	return message.status;
}

async function waitForIndexInRpc(request, root, startedAt = performance.now()) {
	const deadline = Date.now() + indexTimeoutMs;
	let status;
	while (Date.now() < deadline) {
		status = await rpcStatus(request, root);
		if (isIndexReady(status)) return { readinessMs: performance.now() - startedAt, status };
		if (["error", "degraded"].includes(status?.state)) throw new Error(`CodeGraph index failed: ${JSON.stringify(status)}`);
	}
	throw new Error(`Index readiness deadline exceeded in same RPC process; last status=${JSON.stringify(status)}`);
}

async function verifyRpc(cli, root, agentDir) {
	const session = await withRpc(cli, root, agentDir, async ({ request, messages }) => {
		const status = await rpcStatus(request, root);
		const refresh = await request("prompt", { message: "/codegraph refresh" }, (item) => item.type === "codegraph_result" && item.command === "refresh");
		assert.ok(status && refresh.message.status, "missing RPC status/refresh results");
		assertNoProviderActivity(JSON.stringify(messages));
		return { eventTypes: messages.map((event) => event.type) };
	});
	return { argv: session.argv, code: 0, stdout: session.stdout, stderr: session.stderr, ...session.value };
}

async function runCommand(executable, args, options = {}) {
	const { timeout = 10_000, ...spawnOptions } = options;
	return await new Promise((resolvePromise, reject) => {
		const child = spawn(executable, args, { stdio: ["ignore", "pipe", "pipe"], ...spawnOptions });
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeout);
		child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
		child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
		child.once("error", (error) => { clearTimeout(timer); reject(error); });
		child.once("close", (code) => { clearTimeout(timer); if (timedOut) reject(new Error(`${executable} ${args[0]} command timeout after ${timeout}ms; ${stderr}`)); else resolvePromise({ code, stdout, stderr }); });
	});
}

async function tmuxCapture(session) {
	const capture = await runCommand("tmux", ["capture-pane", "-t", session, "-p", "-S", "-100"]);
	assert.equal(capture.code, 0, `tmux capture failed: ${capture.stderr}`);
	return capture.stdout;
}

async function waitForTmux(session, predicate, label, deadlineMs = timeoutMs) {
	const deadline = Date.now() + deadlineMs;
	let last = "";
	while (Date.now() < deadline) {
		const alive = await runCommand("tmux", ["has-session", "-t", session]);
		if (alive.code !== 0) throw new Error(`${label}: tmux session exited before condition; last pane=${last}`);
		last = await tmuxCapture(session);
		if (predicate(last)) return last;
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
	}
	throw new Error(`${label} deadline exceeded; last tmux pane:\n${last}`);
}

async function startTui(cli, root, agentDir, label) {
	const session = `pi-codegraph-host-${process.pid}-${label}`;
	const args = [cli, "--no-session", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-tools"];
	const startedAt = performance.now();
	const created = await runCommand("tmux", ["new-session", "-d", "-s", session, "-x", "80", "-y", "24", "-c", root, process.execPath, ...args], { env: childEnvironment(agentDir) });
	assert.equal(created.code, 0, `tmux create failed: ${created.stderr}`);
	try {
		const ready = await waitForTmux(session, (pane) => pane.includes("Ask Pi to do anything"), "TUI input readiness");
		return { session, args, ready, startedAt, elapsedMs: performance.now() - startedAt };
	} catch (error) {
		await runCommand("tmux", ["kill-session", "-t", session]).catch(() => {});
		throw error;
	}
}

async function submitTuiCommand(session, command) {
	const sent = await runCommand("tmux", ["send-keys", "-t", session, command, "Enter"]);
	assert.equal(sent.code, 0, `tmux input failed: ${sent.stderr}`);
}

async function sendTui(session, command) {
	const before = await tmuxCapture(session);
	await submitTuiCommand(session, command);
	const priorResults = (before.match(/CodeGraph /g) ?? []).length;
	return await waitForTmux(session, (pane) => (pane.match(/CodeGraph /g) ?? []).length > priorResults, `TUI ${command} response`);
}

async function exitTui(session) {
	const sent = await runCommand("tmux", ["send-keys", "-t", session, "C-d"]);
	assert.equal(sent.code, 0, `tmux Ctrl-D failed: ${sent.stderr}`);
	const deadline = Date.now() + 5_000;
	while (Date.now() < deadline) {
		const alive = await runCommand("tmux", ["has-session", "-t", session]);
		if (alive.code !== 0) return;
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
	}
	throw new Error(`TUI did not exit via configured empty-editor Ctrl-D; pane=${(await tmuxCapture(session)).slice(-1500)}`);
}

async function verifyTui(cli, root, agentDir, label) {
	const tui = await startTui(cli, root, agentDir, `functional-${label}`);
	try {
		assert.doesNotMatch(tui.ready, /CodeGraph/, "background CodeGraph work appeared in TUI before an on-demand command");
		for (const command of ["/codegraph status", "/codegraph refresh"]) await sendTui(tui.session, command);
		const finalPane = await tmuxCapture(tui.session);
		await exitTui(tui.session);
		return { session: tui.session, dimensions: "80x24", ready: tui.ready.slice(-2000), finalPane: finalPane.slice(-4000), startupMs: tui.elapsedMs, exited: true };
	} finally { await runCommand("tmux", ["kill-session", "-t", tui.session]).catch(() => {}); }
}

async function benchmarkStartup(cli, root, owned) {
	const results = {};
	for (const condition of ["disabled", "cold", "warm"]) {
		const agentDir = join(owned, `agent-benchmark-${condition}`);
		writeTrust(agentDir, root);
		writeSettings(agentDir, condition !== "disabled");
		if (condition === "warm") {
			const seeded = await withRpc(cli, root, agentDir, async ({ request, startedAt }) => await waitForIndexInRpc(request, root, startedAt));
			assert.ok(isIndexReady(seeded.value.status), "warm seed did not reach ready state");
		}
		const samples = { rpc: [], tui: [] };
		for (let index = 0; index < startupWarmups + startupSamples; index++) {
			const measured = index >= startupWarmups;
			if (condition === "cold") rmSync(join(root, ".codegraph"), { recursive: true, force: true });
			const rpc = await withRpc(cli, root, agentDir, async ({ request, startedAt, firstUsableMs }) => {
				let indexReadinessMs = null;
				if (condition === "cold" || condition === "warm") indexReadinessMs = (await waitForIndexInRpc(request, root, startedAt)).readinessMs;
				if (condition === "disabled") assert.equal((await rpcStatus(request, root)).state, "disabled", "disabled RPC process started CodeGraph indexing");
				return { firstUsableMs, indexReadinessMs };
			});
			const rpcSample = { index: index + 1, measured, firstUsableMs: rpc.value.firstUsableMs, ...(rpc.value.indexReadinessMs === null ? {} : { indexReadinessMs: rpc.value.indexReadinessMs }) };
			samples.rpc.push(rpcSample);
			if (condition === "cold") rmSync(join(root, ".codegraph"), { recursive: true, force: true });
			const tui = await startTui(cli, root, agentDir, `bench-${condition}-${index}`);
			try {
				if (condition === "disabled") {
					assert.doesNotMatch(tui.ready, /CodeGraph (?:starting|indexing|ready) enabled/, "disabled TUI process started CodeGraph indexing");
				}
				await exitTui(tui.session);
			} finally { await runCommand("tmux", ["kill-session", "-t", tui.session]).catch(() => {}); }
			samples.tui.push({ index: index + 1, measured, startupMs: tui.elapsedMs });
		}
		results[condition] = Object.fromEntries(Object.entries(samples).map(([surface, values]) => [surface, {
			warmups: startupWarmups,
			measured: startupSamples,
			samples: values,
			summary: summarize(values.filter((sample) => sample.measured).map((sample) => surface === "rpc" ? sample.firstUsableMs : sample.startupMs)),
		}]));
	}
	return { protocol: { warmups: startupWarmups, measured: startupSamples, rpcFirstUsable: "timestamp captured on matching get_state JSONL response while process remains alive", tuiStartup: "tmux launch through first input-ready prompt", indexReadiness: "same persistent RPC process; status condition state=ready, enabled=true, freshness=current, partial=false", tuiIndexReadiness: "NOT MEASURED; TUI startup measured independently through input-ready prompt" }, conditions: results };
}

function fixtureCounts(root) {
	let files = 0;
	let bytes = 0;
	const visit = (directory) => {
		for (const name of readdirSync(directory, { withFileTypes: true })) {
			const path = join(directory, name.name);
			if (name.isDirectory()) visit(path);
			else { files++; bytes += readFileSync(path).byteLength; }
		}
	};
	visit(root);
	return { files, bytes };
}

export function startupHypotheses(runs) {
	const measuredRuns = Object.fromEntries(Object.entries(runs).filter(([, run]) => run.startup));
	const comparisons = (metric) => Object.fromEntries(Object.entries(measuredRuns).map(([mode, run]) => [mode, Object.fromEntries(["rpc", "tui"].map((surface) => {
		const baselineMs = run.startup.conditions.disabled[surface].summary[metric];
		const warmMs = run.startup.conditions.warm[surface].summary[metric];
		return [surface, { baselineMs, warmMs, overheadMs: warmMs - baselineMs }];
	}))]));
	const classify = (values, targetMs) => ({
		targetMs,
		status: Object.keys(values).length === 0 ? "NOT MEASURED" : Object.values(values).every((mode) => Object.values(mode).every((value) => value.overheadMs <= targetMs)) ? "MET" : "MISSED",
		...(Object.keys(values).length === 0 ? { reason: "Startup benchmark was disabled." } : {}),
		comparisons: values,
	});
	return {
		warmStartupMedianOverhead: classify(comparisons("median"), 100),
		warmStartupP95Overhead: classify(comparisons("p95"), 200),
		indexingEventLoopP95: { status: "NOT MEASURED", reason: "Host harness does not sample event-loop delay." },
		mediumQueryP95: { status: "NOT MEASURED", reason: "Host harness does not benchmark query latency." },
		mediumWatcherP95: { status: "NOT MEASURED", reason: "Host harness disables watchers and does not benchmark watcher latency." },
		structuralRetrievalPayloadReduction: { status: "NOT MEASURED", reason: "Host harness does not measure provider-visible definitions or transport payloads." },
	};
}

async function main() {
	const args = process.argv.slice(2);
	if (args.includes("--help") || args.includes("-h")) { console.log("Usage: node scripts/native-codegraph-host-evidence.mjs [--cli bundled|unbundled|both] [--no-benchmark]"); return; }
	const cliChoice = args.includes("--cli") ? args[args.indexOf("--cli") + 1] : "both";
	if (!new Set(["bundled", "unbundled", "both"]).has(cliChoice)) throw new Error(`Invalid --cli: ${cliChoice}`);
	const selected = cliChoice === "both" ? Object.entries(modes) : [[cliChoice, modes[cliChoice]]];
	for (const [, cli] of selected) if (!existsSync(cli)) throw new Error(`Built CLI missing: ${cli}. Parent must run approved offline build first; rerun this harness after build.`);
	const owned = mkdtempSync(join(tmpdir(), "pi-native-codegraph-host-"));
	const root = join(owned, "project");
	mkdirSync(root, { recursive: true });
	cpSync(fixtureDir, root, { recursive: true });
	const agentDir = join(owned, "agent-protocol");
	writeTrust(agentDir, root);
	writeSettings(agentDir, true);
	mkdirSync(artifactDir, { recursive: true });
	const resourceBaseline = processResources();
	const cpuBaseline = process.cpuUsage();
	const bundleChunksDir = join(packageDir, "dist/bundle/chunks");
	const runtimeFiles = [
		...selected.map(([, cli]) => cli),
		...(existsSync(bundleChunksDir) ? readdirSync(bundleChunksDir, { withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => join(bundleChunksDir, entry.name)) : []),
		join(packageDir, "dist/core/codegraph/worker.mjs"),
	].filter(existsSync);
	const report = {
		schemaVersion: 2,
		startedAt: new Date().toISOString(),
		metadata: {
			sha: (await runCommand("git", ["rev-parse", "HEAD"], { cwd: repo })).stdout.trim(),
			dirtyPaths: (await runCommand("git", ["status", "--short"], { cwd: repo })).stdout.trim().split(/\r?\n/).filter(Boolean),
			node: process.version,
			platform: `${process.platform}/${process.arch}`,
				cpu: `${process.arch}; ${JSON.stringify(cpus()[0] ?? null)}; logical=${cpus().length}`,
			memoryBytes: totalmem(),
				cliAndWorkerSha256: Object.fromEntries(runtimeFiles.map((path) => [path.slice(repo.length + 1), sha256(path)])),
			corpus: { ...fixtureCounts(root), fixtureManifestSha256: sha256(join(repo, "docs/native-codegraph-artifacts/track-c/ground-truth.json")) },
			grant: "exact canonical temporary corpus root persisted in harness-owned trust.json",
			providerCalls: "none requested; slash commands and direct local tool execution only; no model prompt issued",
		},
		runs: {},
	};
	try {
		for (const [name, cli] of selected) {
			const outputs = {};
			for (const mode of ["text", "json"]) {
				outputs[mode] = [];
				for (const command of ["/codegraph status", "/codegraph refresh"]) outputs[mode].push(await verifyPrintMode(cli, mode, root, agentDir, command));
			}
			outputs.rpc = await verifyRpc(cli, root, agentDir);
			outputs.sdk = await verifySdk(root, agentDir);
			outputs.tui = await verifyTui(cli, root, agentDir, name);
			if (!args.includes("--no-benchmark")) outputs.startup = await benchmarkStartup(cli, root, owned);
			report.runs[name] = outputs;
		}
		report.hypotheses = startupHypotheses(report.runs);
		const resourceFinal = processResources();
		const remainingChildren = resourceFinal.directChildren.filter((pid) => !resourceBaseline.directChildren.includes(pid));
		assert.deepEqual(remainingChildren, [], `harness left child processes alive: ${remainingChildren.join(", ")}`);
		report.resources = { before: resourceBaseline, after: resourceFinal, harnessCpuMs: (() => { const delta = process.cpuUsage(cpuBaseline); return (delta.user + delta.system) / 1000; })(), ownedProcessCleanup: "Every persistent RPC/TUI child awaited exit under a bounded deadline." };
		const stamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
		const jsonPath = join(artifactDir, `host-evidence-${stamp}.json`);
		const textPath = join(artifactDir, `host-evidence-${stamp}.txt`);
		writeJson(jsonPath, report);
		const summaries = Object.entries(report.runs).map(([name, run]) => {
			if (!run.startup) return `${name}: text/json/RPC/SDK/TUI passed; startup NOT MEASURED (--no-benchmark)`;
			return `${name}: ${Object.entries(run.startup.conditions).map(([condition, surfaces]) => `${condition} RPC median/p95=${surfaces.rpc.summary.median.toFixed(1)}/${surfaces.rpc.summary.p95.toFixed(1)}ms; TUI=${surfaces.tui.summary.median.toFixed(1)}/${surfaces.tui.summary.p95.toFixed(1)}ms`).join("; ")}`;
		});
		const hypotheses = `Hypotheses: warm startup median overhead ${report.hypotheses.warmStartupMedianOverhead.status}; warm startup p95 overhead ${report.hypotheses.warmStartupP95Overhead.status}; indexing event-loop p95 NOT MEASURED; medium query p95 NOT MEASURED; watcher p95 NOT MEASURED; structural payload reduction NOT MEASURED`;
		writeFileSync(textPath, `Native CodeGraph host evidence\nSHA: ${report.metadata.sha}\nNode: ${report.metadata.node}\nPlatform: ${report.metadata.platform}\nCPU: ${report.metadata.cpu}\nMemory: ${report.metadata.memoryBytes} bytes\nFixture files/bytes: ${report.metadata.corpus.files}/${report.metadata.corpus.bytes}\nModes: ${Object.keys(report.runs).join(", ")}\n${summaries.join("\n")}\n${hypotheses}\n`);
		console.log(JSON.stringify({ status: "PASS", artifacts: [jsonPath, textPath], summary: readFileSync(textPath, "utf8") }, null, 2));
	} finally { rmSync(owned, { recursive: true, force: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((error) => { console.error(error instanceof Error ? error.stack : String(error)); process.exitCode = 1; });
