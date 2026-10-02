import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { captureSessionTranscript, measureAdapterInputs } from "./native-codegraph-retrieval-accounting-session.mjs";
import { createOfflineTextTools, median, sourceVerificationReads } from "./native-codegraph-retrieval-accounting.mjs";
import { createHarness } from "../packages/coding-agent/test/suite/harness.ts";

const captureTool = {
 name: "capture",
 label: "Capture",
 description: "Return supplied value for offline accounting tests.",
 parameters: Type.Object({ value: Type.String() }),
 execute: async (_id, { value }) => ({ content: [{ type: "text", text: `captured:${value}` }] }),
};

test("captures actual faux-provider inputs across AgentSession tool-result follow-up", async () => {
 const harness = await createHarness({ tools: [captureTool], initialActiveToolNames: ["capture"] });
 try {
  const result = await captureSessionTranscript(harness, "capture unicode λ", [
   { name: "capture", arguments: { value: "λ" } },
  ]);
  assert.equal(result.requests.length, 2);
  assert.equal(result.requests[0].messages.at(-1).role, "user");
  assert.equal(result.requests[1].messages.at(-1).role, "toolResult");
  assert.match(JSON.stringify(result.requests[0].messages), /capture/);
  assert.match(JSON.stringify(result.requests[1].messages), /captured:λ/);
  assert.match(JSON.stringify(result.requests[0].messages), /Return supplied value/);
  const sizes = measureAdapterInputs([{ messages: [{ role: "user", content: "λ" }] }]);
  const serialized = JSON.stringify([{ role: "user", content: "λ" }]);
  assert.deepEqual(sizes.requestBytes, [Buffer.byteLength(serialized, "utf8")]);
  assert.deepEqual(sizes.requestCharacters, [serialized.length]);
  assert.equal(result.transcript.filter((message) => message.role === "toolResult").length, 1);
 } finally {
  harness.cleanup();
 }
});

test("source read capture preserves real multiline hit windows and Unicode", async () => {
 const root = mkdtempSync(join(tmpdir(), "pi-codegraph-accounting-read-"));
 writeFileSync(join(root, "probe.ts"), "first\nsecond λ\nthird\nfourth\n");
 const harness = await createHarness({ tools: createOfflineTextTools(root), initialActiveToolNames: ["read"] });
 try {
  const result = await captureSessionTranscript(harness, "Read lines 2-3", [
   { name: "read", arguments: { file: "probe.ts", startLine: 2, endLine: 3 } },
  ]);
  const source = result.requests[1].messages.find((message) => message.role === "toolResult");
  assert.equal(source.content[0].text, "second λ\nthird");
  assert.equal(source.isError, false);
 } finally {
  harness.cleanup();
  rmSync(root, { recursive: true, force: true });
 }
});

test("verification reads cover only returned provenance, including resolved subjects", () => {
 const root = mkdtempSync(join(tmpdir(), "pi-codegraph-accounting-provenance-"));
 writeFileSync(join(root, "seed.ts"), "export function seed() { return 1; }\n");
 writeFileSync(join(root, "neighbor.ts"), "export function neighbor() { return seed(); }\n");
 try {
  assert.deepEqual(sourceVerificationReads(root, { nodes: [], files: [], edges: [] }), []);
  const result = { subject: { file: "seed.ts", startLine: 1, endLine: 1 }, nodes: [{ file: "neighbor.ts", startLine: 1, endLine: 1 }], files: [] };
  const reads = sourceVerificationReads(root, result);
  assert.deepEqual(reads.map((read) => read.file), ["neighbor.ts", "seed.ts"]);
  assert.ok(reads.every((read) => read.lines[0].startsWith("export function")));
  assert.deepEqual(sourceVerificationReads(root, result, ["seed.ts"]).map((read) => read.file), ["neighbor.ts"]);
 } finally { rmSync(root, { recursive: true, force: true }); }
});

test("median uses midpoint for even-sized samples and does not mutate input", () => {
 const values = [7, 1, 5, 3];
 assert.equal(median(values), 4);
 assert.deepEqual(values, [7, 1, 5, 3]);
});
test("median returns middle value for odd-sized samples", () => {
 assert.equal(median([9, 1, 4]), 4);
});
test("median rejects empty samples", () => {
 assert.throws(() => median([]), /median requires values/);
});
