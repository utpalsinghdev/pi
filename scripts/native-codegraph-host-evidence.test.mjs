import assert from "node:assert/strict";
import { test } from "node:test";
import { createJsonlDecoder, isIndexReady, percentile, rpcResponseElapsed, startupHypotheses, summarize } from "./native-codegraph-host-evidence.mjs";

test("startup summaries use nearest-rank percentiles and preserve raw samples", () => {
	assert.equal(percentile([9, 1, 5, 3, 7], 0.5), 5);
	assert.equal(percentile([9, 1, 5, 3, 7], 0.95), 9);
	assert.deepEqual(summarize([9, 1, 5, 3, 7]), { count: 5, median: 5, p95: 9, samplesMs: [9, 1, 5, 3, 7] });
	assert.equal(percentile([], 0.95), null);
});

test("JSONL decoder buffers split records and rejects incomplete tails", () => {
	const messages = [];
	const errors = [];
	const decode = createJsonlDecoder((message) => messages.push(message), (error) => errors.push(error));
	decode('{"type":"res');
	assert.deepEqual(messages, []);
	decode('ponse","id":"one"}\r\n{"type":"event"}\n');
	decode.finish();
	assert.deepEqual(messages, [{ type: "response", id: "one" }, { type: "event" }]);
	assert.deepEqual(errors, []);
	decode('{"type":');
	assert.throws(() => decode.finish(), /Incomplete RPC JSONL record/);
});

test("first-usable timing is captured only at matching successful get_state response", () => {
	const start = 10;
	assert.equal(rpcResponseElapsed({ type: "event", id: "ready" }, "ready", start, 15), null);
	assert.equal(rpcResponseElapsed({ type: "response", id: "other", command: "get_state", success: true }, "ready", start, 15), null);
	assert.equal(rpcResponseElapsed({ type: "response", id: "ready", command: "get_state", success: false }, "ready", start, 15), null);
	assert.equal(rpcResponseElapsed({ type: "response", id: "ready", command: "get_state", success: true }, "ready", start, 16.25), 6.25);
});

test("startup hypotheses stay NOT MEASURED when benchmark is disabled", () => {
	const hypotheses = startupHypotheses({ bundled: {} });
	assert.equal(hypotheses.warmStartupMedianOverhead.status, "NOT MEASURED");
	assert.equal(hypotheses.warmStartupP95Overhead.status, "NOT MEASURED");
});

test("index readiness requires completed, current, non-partial enabled state", () => {
	assert.equal(isIndexReady({ state: "ready", enabled: true, freshness: "current", partial: false }), true);
	for (const override of [{ state: "indexing" }, { enabled: false }, { freshness: "stale" }, { partial: true }]) {
		assert.equal(isIndexReady({ state: "ready", enabled: true, freshness: "current", partial: false, ...override }), false);
	}
});
