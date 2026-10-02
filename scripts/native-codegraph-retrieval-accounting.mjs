#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { createHarness } from "../packages/coding-agent/test/suite/harness.ts";
import { acquireCodegraph } from "../packages/coding-agent/src/core/codegraph/controller.ts";
import { createCodebaseTool } from "../packages/coding-agent/src/core/tools/codebase.ts";
import { captureSessionTranscript, measureAdapterInputs } from "./native-codegraph-retrieval-accounting-session.mjs";
import {
 actualFacts,
 baselineFacts,
 fixtureDirectory,
 groundTruthPath,
 runTargetedTextBaseline,
 runtimeMetadata,
 scoreFacts,
 validateFixtures,
 shouldUseTextFallback,
 trackDirectory,
} from "./benchmark-native-codegraph.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = join(trackDirectory, "accounting");
const csvEscape = (value) => `"${String(value).replaceAll('"', '""')}"`;
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const duration = (start) => Number((performance.now() - start).toFixed(3));

export function sourceVerificationReads(root, result, fallbackFiles = []) {
 const nodes = [...(result.subject ? [result.subject] : []), ...(result.nodes ?? [])].filter((node) => !fallbackFiles.includes(node.file));
 const files = [...new Set([...(result.files ?? []), ...nodes.map((node) => node.file), ...(result.snippets ?? []).map((snippet) => snippet.file)])].filter((file) => !fallbackFiles.includes(file));
 const ranges = new Map();
 const addRange = (file, startLine, endLine) => {
  const previous = ranges.get(file);
  ranges.set(file, previous ? { startLine: Math.min(startLine, previous.startLine), endLine: Math.max(endLine, previous.endLine) } : { startLine, endLine });
 };
 for (const node of nodes) addRange(node.file, Math.max(1, node.startLine - 5), node.endLine + 5);
 for (const file of files) {
  if (ranges.has(file)) continue;
  const lines = readFileSync(join(root, file), "utf8").split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
   if (!/\b(?:import|from|require)\b/.test(lines[index])) continue;
   addRange(file, Math.max(1, index + 1 - 5), Math.min(lines.length, index + 1 + 5));
  }
  if (!ranges.has(file)) addRange(file, 1, Math.min(lines.length, 11));
 }
 return [...ranges].sort(([a], [b]) => a.localeCompare(b)).map(([file, range]) => {
  const sourceLines = readFileSync(join(root, file), "utf8").split(/\r?\n/);
  const endLine = Math.min(sourceLines.length, range.endLine);
  return { file, startLine: range.startLine, endLine, lines: sourceLines.slice(range.startLine - 1, endLine) };
 });
}

function metrics(capture, toolCalls, files, lines, latencyMs) {
 const inputSizes = measureAdapterInputs(capture.requests);
 const bytes = inputSizes.requestBytes.reduce((sum, value) => sum + value, 0);
 const characters = inputSizes.requestCharacters.reduce((sum, value) => sum + value, 0);
 return {
  capture,
  toolCalls,
  filesRead: [...new Set(files)].sort(),
  fileCount: new Set(files).size,
  linesRead: lines,
  latencyMs,
  requestCount: inputSizes.requestBytes.length,
  requestBytes: inputSizes.requestBytes,
  requestCharacters: inputSizes.requestCharacters,
  bytes,
  characters,
  bytesDividedBy4Proxy: Math.ceil(bytes / 4),
 };
}

function csvReport(rows) {
 const columns = ["task", "class", "operation", "baselineBytes", "nativeBytes", "baselineCalls", "nativeCalls", "baselineFiles", "nativeFiles", "baselineLines", "nativeLines", "baselineMs", "nativeMs", "baselineFileRecall", "nativeFileRecall", "baselineSymbolRecall", "nativeSymbolRecall", "baselineEdgeRecall", "nativeEdgeRecall", "missingNativeEdges"];
 return [columns, ...rows.map((row) => [row.task, row.class, row.operation, row.baseline.bytes, row.native.bytes, row.baseline.toolCalls, row.native.toolCalls, row.baseline.fileCount, row.native.fileCount, row.baseline.linesRead, row.native.linesRead, row.baseline.latencyMs, row.native.latencyMs, row.baselineScore.files.recall, row.nativeScore.files.recall, row.baselineScore.symbols.recall, row.nativeScore.symbols.recall, row.baselineScore.edges.recall, row.nativeScore.edges.recall, row.nativeScore.edges.missing.join(";")])].map((row) => row.map(csvEscape).join(",")).join("\n") + "\n";
}

export function median(values) {
 assert.ok(values.length > 0, "median requires values");
 const sorted = [...values].sort((a, b) => a - b);
 const middle = Math.floor(sorted.length / 2);
 return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

const baselineGuidance = {
   tools: [
    { name: "rg", description: "Search exact source text and return matching file, line, and text." },
    { name: "find", description: "Locate files by path or name when needed." },
    { name: "read", description: "Read bounded source ranges around relevant hits to verify code." },
   ],
   guidance: "Use targeted searches and bounded hit windows; preserve distinct hits; read source before conclusions.",
  };
export function createOfflineTextTools(project) {
 return [
   {
    name: "rg", label: "rg", description: baselineGuidance.tools[0].description,
    parameters: Type.Object({ terms: Type.Array(Type.String()), target: Type.String() }),
    execute: async (_id, input) => {
     const expression = input.terms.length === 1 && input.terms[0].startsWith("\\b") ? input.terms[0] : `(?:${input.terms.join("|")})`;
     const args = ["--line-number", "--no-heading", "--with-filename", "--hidden", "--glob", "!.codegraph/**", "--glob", "!codegraph.json", "-i", "-e", expression, input.target];
     let output = "";
     try { output = execFileSync("rg", args, { cwd: project, encoding: "utf8", maxBuffer: 1_000_000 }); }
     catch (error) { if (error.status !== 1) throw error; }
     return { content: [{ type: "text", text: output }] };
    },
   },
   {
    name: "find", label: "find", description: baselineGuidance.tools[1].description,
    parameters: Type.Object({ path: Type.String() }),
    execute: async (_id, input) => ({ content: [{ type: "text", text: input.path }] }),
   },
   {
    name: "read", label: "read", description: baselineGuidance.tools[2].description,
    parameters: Type.Object({ file: Type.String(), startLine: Type.Integer(), endLine: Type.Integer() }),
    execute: async (_id, input) => {
     const lines = readFileSync(join(project, input.file), "utf8").split(/\r?\n/);
     return { content: [{ type: "text", text: lines.slice(input.startLine - 1, input.endLine).join("\n") }] };
    },
   },
 ];
}

export async function runRetrievalAccounting() {
 const frozen = JSON.parse(readFileSync(groundTruthPath, "utf8"));
 assert.equal(frozen.frozenBeforeCandidateRuns, true);
 assert.equal(frozen.tasks.length, 15, "accounting is pinned to the 15 frozen tasks");
 const temp = mkdtempSync(join(repo, ".native-codegraph-accounting-"));
 const project = join(temp, "project");
 cpSync(fixtureDirectory, project, { recursive: true });
 const service = acquireCodegraph({ cwd: project, grant: { root: project }, settings: { enabled: true, watch: false } });
 try {
  const deadline = Date.now() + 120_000;
  let status = service.status();
  while (!(status.state === "ready" && status.freshness === "current" && status.revision)) {
   assert.ok(Date.now() < deadline, `index readiness timed out: ${JSON.stringify(status)}`);
   await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
   status = service.status();
  }
  const rows = [];
  for (const task of frozen.tasks) {
   const offlineTools = createOfflineTextTools(project);
   const baselineStart = performance.now();
   const baselineResult = runTargetedTextBaseline(project, task);
   const baselineCalls = [
    ...baselineResult.transcript.commands.map((command) => ({ name: "rg", arguments: { terms: command.slice(1, -1), target: command.at(-1) } })),
    ...baselineResult.transcript.windows.map((window) => ({ name: "read", arguments: { file: window.file, startLine: window.startLine, endLine: window.startLine + window.lines.length - 1 } })),
   ];
   const baselineHarness = await createHarness({ tools: offlineTools, initialActiveToolNames: ["rg", "find", "read"] });
   let baselineCapture;
   try { baselineCapture = await captureSessionTranscript(baselineHarness, `${baselineGuidance.guidance}\nFrozen task: ${JSON.stringify(task.request)}`, baselineCalls); }
   finally { baselineHarness.cleanup(); }
   assert.deepEqual(
    baselineCapture.transcript.filter((message) => message.role === "toolResult" && message.toolName === "read").map((message) => message.content[0]?.text),
    baselineResult.transcript.windows.map((window) => window.lines.join("\n")),
    `Captured baseline reads must match planned hit windows for ${task.id}`,
   );
   assert.ok(baselineCapture.transcript.filter((message) => message.role === "toolResult").every((message) => !message.isError), `Baseline tool execution failed for ${task.id}`);
   const baseline = metrics(baselineCapture, baselineCalls.length, baselineResult.files, baselineResult.linesRead, duration(baselineStart));
   const nativeStart = performance.now();
   const result = await service.query(task.request);
   const fallback = shouldUseTextFallback(task, result) ? runTargetedTextBaseline(project, task) : undefined;
   const facts = actualFacts(task, result);
   const fallbackFacts = fallback ? baselineFacts(task, fallback) : { files: [], symbols: [], edges: [] };
   const scoredFacts = {
    files: [...new Set([...facts.files, ...fallbackFacts.files])],
    symbols: [...new Set([...facts.symbols, ...fallbackFacts.symbols])],
    edges: [...new Set([...facts.edges, ...fallbackFacts.edges])],
   };
   const verificationReads = sourceVerificationReads(project, result, fallback?.files);
   const verifiedFiles = verificationReads.map((read) => read.file);
   const nativeCalls = [
    { name: "codebase", arguments: task.request },
    ...(fallback?.transcript.commands.map((command) => ({ name: "rg", arguments: { terms: command.slice(1, -1), target: command.at(-1) } })) ?? []),
    ...(fallback?.transcript.windows.map((window) => ({ name: "read", arguments: { file: window.file, startLine: window.startLine, endLine: window.startLine + window.lines.length - 1 } })) ?? []),
    ...verificationReads.map((item) => ({ name: "read", arguments: { file: item.file, startLine: item.startLine, endLine: item.endLine } })),
   ];
   const nativeHarness = await createHarness({ tools: [...offlineTools, createCodebaseTool(service)], initialActiveToolNames: ["codebase", "rg", "find", "read"] });
   let nativeCapture;
   try { nativeCapture = await captureSessionTranscript(nativeHarness, `Query indexed static symbols/relationships. Search is lexical, not embeddings. Use grep for literals, arbitrary source, generated/unindexed files, or unsupported languages. Graph links may be heuristic; read source before edits.\nFrozen task: ${JSON.stringify(task.request)}`, nativeCalls); }
   finally { nativeHarness.cleanup(); }
   const codebaseToolResult = nativeCapture.transcript.find((message) => message.role === "toolResult" && message.toolName === "codebase");
   assert.ok(codebaseToolResult && !codebaseToolResult.isError, `AgentSession codebase tool failed for ${task.id}`);
   assert.deepEqual(JSON.parse(codebaseToolResult.content[0].text), result, `Captured graph result differs from scored result for ${task.id}`);
   assert.deepEqual(
    nativeCapture.transcript.filter((message) => message.role === "toolResult" && message.toolName === "read").map((message) => message.content[0]?.text),
    [...(fallback?.transcript.windows ?? []), ...verificationReads].map((window) => window.lines.join("\n")),
    `Captured native reads must match fallback and verification windows for ${task.id}`,
   );
   assert.ok(nativeCapture.transcript.filter((message) => message.role === "toolResult").every((message) => !message.isError), `Native tool execution failed for ${task.id}`);
   const nativeFiles = [...verifiedFiles, ...(fallback?.files ?? [])];
   assert.ok(facts.files.every((file) => nativeFiles.includes(file)), `Every returned fact file must be source-verified for ${task.id}`);
   const nativeLines = verificationReads.reduce((sum, item) => sum + item.lines.length, 0) + (fallback?.linesRead ?? 0);
   const native = metrics(nativeCapture, nativeCalls.length, nativeFiles, nativeLines, duration(nativeStart));
   const toScore = (values) => ({ files: scoreFacts(task.expected.files, values.files), symbols: scoreFacts(task.expected.symbols, values.symbols), edges: scoreFacts(task.expected.edges, values.edges) });
   rows.push({ task: task.id, operation: task.operation, class: /literal|missing|ambiguous|paraphrase/.test(task.id) ? "literal-negative-ambiguous-or-heuristic" : "structural", baseline, native, baselineScore: toScore(baselineFacts(task, baselineResult)), nativeScore: toScore(scoredFacts), nativeDirectScore: toScore(facts), fallback: Boolean(fallback), truncated: result.truncated, nextOffset: result.nextOffset ?? null });
  }
  const structural = rows.filter((row) => row.class === "structural");
  const reductions = structural.map((row) => 1 - row.native.bytes / row.baseline.bytes);
  const structuralMedianReduction = median(reductions);
  const allRequiredEdgesComplete = rows.every((row) => row.nativeScore.edges.missing.length === 0);
  const allFrozenFactsComplete = rows.every((row) => Object.values(row.nativeScore).every((score) => score.missing.length === 0));
  assert.equal(allRequiredEdgesComplete, true, "all frozen expected direct edges must remain present");
  assert.equal(allFrozenFactsComplete, true, "all frozen expected files, symbols and edges must remain present");
  const nativeMetadata = runtimeMetadata();
  const metadata = {
   sha: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim(),
   diffState: execFileSync("git", ["status", "--short"], { cwd: repo, encoding: "utf8" }).trim().split(/\r?\n/).filter((entry) => entry && !entry.includes(".native-codegraph-accounting-")),
   node: process.versions.node,
   platform: `${process.platform}/${process.arch}`,
   runtime: process.execPath,
   codegraphVersion: JSON.parse(readFileSync(join(repo, "package-lock.json"), "utf8")).packages?.["node_modules/@colbymchenry/codegraph"]?.version ?? null,
   frozenGroundTruthSha256: sha256(readFileSync(groundTruthPath)),
   fixtureSourceSha256: validateFixtures().fixtureSha256,
   accountingScriptSha256: sha256(readFileSync(fileURLToPath(import.meta.url))),
   captureHelperSha256: sha256(readFileSync(join(repo, "scripts/native-codegraph-retrieval-accounting-session.mjs"))),
   sessionHarnessSha256: sha256(readFileSync(join(repo, "packages/coding-agent/test/suite/harness.ts"))),
   benchmarkHarnessSha256: nativeMetadata.harnessSha256,
   candidateSourcesSha256: nativeMetadata.candidateSourcesSha256,
   fixtureManifestSha256: sha256(JSON.stringify(Object.fromEntries(frozen.tasks.map((task) => [task.id, task.expected])))),
   protocol: { tasks: rows.length, repeatsPerTask: 1, percentileMethod: "not applicable; one observation per task", corpus: "frozen 10-source-file fixture; isolated copied root", fallbackPolicy: "same existing shouldUseTextFallback(task, result); never reads expected facts" },
  };
  const report = {
   schemaVersion: 1,
   status: "OFFLINE_RETRIEVAL_ACCOUNTING",
   metadata,
   measurement: {
    basis: "Actual normalized TranscriptContext.messages captured at faux provider streamSimple input from real AgentSession orchestration. Captures include context/system messages with available tool definitions and guidance, scripted tool calls, resulting tool-result messages, and subsequent provider requests. Each request's messages are JSON-serialized for exact UTF-8/character accounting; cumulative bytes sum all requests per task.",
    fauxProviderRequestCapture: "CAPTURED OFFLINE. Faux provider response factories record real adapter-input TranscriptContext for each request. No vendor HTTP request or network/provider call occurs. This is pre-vendor serialization input, not vendor wire bytes.",
    payload: "UTF-8 bytes and JavaScript characters are exact for JSON.stringify(request.messages). bytesDividedBy4Proxy = ceil(cumulative UTF-8 bytes / 4), labeled proxy only, not tokenizer output or token count.",
    captureSeam: "@earendil-works/pi-ai faux provider response factory receives normalized TranscriptContext immediately before provider adapter processing; actual provider adapter serialization/HTTP payload is unavailable at this seam.",

    latency: "Single-run wall-clock harness latency includes deterministic planning searches/query/reads and their subsequent AgentSession replay. Planning work is repeated, so this is not production retrieval latency. Local filesystem/index cache conditions are uncontrolled and warm after initial indexing.",
    structuralMedianPayloadReduction: { value: structuralMedianReduction, hypothesis: ">= 0.30", status: structuralMedianReduction >= 0.30 ? "MET" : "MISSED", releaseGate: false },
    requiredFrozenEdgesComplete: allRequiredEdgesComplete,
    requiredFrozenFactsComplete: allFrozenFactsComplete,
    tokenizer: "None selected. Dependency inspection did not identify an installed tokenizer with declared model/encoding suitable for this transcript.",
   },
   rows,
  };
  mkdirSync(outputDirectory, { recursive: true });
  const stamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
  const jsonPath = join(outputDirectory, `retrieval-accounting-${stamp}.json`);
  const csvPath = join(outputDirectory, `retrieval-accounting-${stamp}.csv`);
  const json = `${JSON.stringify(report, null, 2)}\n`;
  const csv = csvReport(rows);
  writeFileSync(jsonPath, json);
  writeFileSync(csvPath, csv);
  console.log(JSON.stringify({ ...report, artifacts: { json: relative(repo, jsonPath), csv: relative(repo, csvPath) }, rows: rows.map(({ baseline, native, ...row }) => ({ ...row, baseline: { bytes: baseline.bytes, characters: baseline.characters, toolCalls: baseline.toolCalls, fileCount: baseline.fileCount, linesRead: baseline.linesRead, latencyMs: baseline.latencyMs }, native: { bytes: native.bytes, characters: native.characters, toolCalls: native.toolCalls, fileCount: native.fileCount, linesRead: native.linesRead, latencyMs: native.latencyMs } })) }, null, 2));
  return report;
 } finally {
  service.dispose();
  await service.disposed;
  rmSync(temp, { recursive: true, force: true });
 }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
 runRetrievalAccounting().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
 });
}
