import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireCodegraph } from "../src/core/codegraph/controller.ts";
import type { CodegraphService } from "../src/core/codegraph/types.ts";

const roots: string[] = [];
const services: CodegraphService[] = [];

async function fixture(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "pi-codegraph-policy-"));
	roots.push(root);
	await writeFile(join(root, "entry.ts"), "export function entry() { return 1; }\n");
	return root;
}

async function settled(service: CodegraphService): Promise<void> {
	const deadline = Date.now() + 15_000;
	while (Date.now() < deadline) {
		if (["ready", "error", "degraded", "disabled"].includes(service.status().state)) return;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new Error(`Index deadline exceeded: ${JSON.stringify(service.status())}`);
}

afterEach(async () => {
	for (const service of services.splice(0)) {
		service.dispose();
		await service.disposed;
	}
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("CodeGraph explicit policy", () => {
	it("reports settings opt-out as disabled, even without indexing consent", async () => {
		const root = await fixture();
		for (const grant of [undefined, { root }]) {
			const service = acquireCodegraph({ cwd: root, grant, settings: { enabled: false } });
			services.push(service);
			expect(service.status().reason).toBe("Disabled by settings");
			expect((await service.query({ operation: "search", query: "entry" })).status).toBe("disabled");
		}
	});

	it("fails closed for conflicting same-root policy and reconciles after all owners release", async () => {
		const root = await fixture();
		await writeFile(join(root, "private.ts"), "export function privateSourceMarker() { return 2; }\n");
		const first = acquireCodegraph({ cwd: root, grant: { root }, settings: { watch: false } });
		services.push(first);
		await settled(first);
		expect((await first.query({ operation: "search", query: "privateSourceMarker" })).nodes.length).toBeGreaterThan(
			0,
		);
		const settings = { watch: false, exclude: ["private.ts"] };
		const conflicting = acquireCodegraph({ cwd: root, grant: { root }, settings });
		services.push(conflicting);
		expect(conflicting.status().state).toBe("disabled");
		expect(conflicting.status().reason).toContain("different settings");
		const denied = await conflicting.query({ operation: "search", query: "privateSourceMarker" });
		expect(denied.status).toBe("disabled");
		expect(denied.nodes).toEqual([]);
		first.dispose();
		await first.disposed;
		const reopened = acquireCodegraph({ cwd: root, grant: { root }, settings });
		services.push(reopened);
		await settled(reopened);
		expect(reopened.status().state, JSON.stringify(reopened.status())).toBe("ready");
		expect((await reopened.query({ operation: "search", query: "privateSourceMarker" })).nodes).toEqual([]);
	});

	it("shares equivalent settings but rejects conflicting watcher settings", async () => {
		const root = await fixture();
		const first = acquireCodegraph({
			cwd: root,
			grant: { root },
			settings: { watch: false, exclude: ["a.ts", "b.ts"] },
		});
		services.push(first);
		const equivalent = acquireCodegraph({
			cwd: root,
			grant: { root },
			settings: { watch: false, debounceMs: 250, exclude: ["b.ts", "a.ts", "a.ts"] },
		});
		services.push(equivalent);
		await settled(first);
		expect(equivalent.status().state).toBe("ready");
		const conflicting = acquireCodegraph({
			cwd: root,
			grant: { root },
			settings: { watch: true, exclude: ["a.ts", "b.ts"] },
		});
		services.push(conflicting);
		expect(conflicting.status().state).toBe("disabled");
		expect(first.status().watcher).toBe("off");
	});

	it("keeps child launch independent of host liftoff-only flag", async () => {
		const root = await fixture();
		const original = process.execArgv.slice();
		let service: CodegraphService;
		try {
			process.execArgv.push("--liftoff-only");
			service = acquireCodegraph({ cwd: root, grant: { root }, settings: { watch: false } });
			services.push(service);
		} finally {
			process.execArgv.splice(0, process.execArgv.length, ...original);
		}
		await settled(service);
		expect(service.status().state, JSON.stringify(service.status())).toBe("ready");
		expect(
			(await service.query({ operation: "symbols", file: "entry.ts" })).nodes.some((node) => node.name === "entry"),
		).toBe(true);
	});
});
