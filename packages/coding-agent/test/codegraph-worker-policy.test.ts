import { existsSync } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { acquireCodegraph } from "../src/core/codegraph/controller.ts";
import type { CodegraphService } from "../src/core/codegraph/types.ts";

const roots: string[] = [];
const services: CodegraphService[] = [];

async function fixture(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "pi-codegraph-worker-policy-"));
	roots.push(root);
	await mkdir(join(root, "src"));
	await writeFile(join(root, "src", "entry.ts"), "export function safeEntry() { return 1; }\n");
	return root;
}

function acquire(root: string, exclude: string[] = []): CodegraphService {
	const service = acquireCodegraph({ cwd: root, grant: { root }, settings: { exclude } });
	services.push(service);
	return service;
}

async function waitUntilSettled(service: CodegraphService): Promise<void> {
	const deadline = Date.now() + 30_000;
	while (Date.now() < deadline) {
		if (["ready", "degraded", "error"].includes(service.status().state)) return;
		await new Promise((resolve) => setTimeout(resolve, 30));
	}
	throw new Error(`CodeGraph worker did not settle: ${JSON.stringify(service.status())}`);
}

function indexedPaths(root: string): string[] {
	const db = new DatabaseSync(join(root, ".codegraph", "codegraph.db"), { readOnly: true });
	try {
		return (db.prepare("SELECT path FROM files ORDER BY path").all() as Array<{ path: string }>).map(
			({ path }) => path,
		);
	} finally {
		db.close();
	}
}

afterEach(async () => {
	for (const service of services.splice(0)) {
		service.dispose();
		await service.disposed;
	}
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("CodeGraph worker privacy policy", () => {
	it.skipIf(process.platform === "win32")(
		"creates owner-private graph state without changing host umask",
		async () => {
			const root = await fixture();
			const hostUmask = process.umask();
			const service = acquire(root);
			await waitUntilSettled(service);
			expect(service.status().state).toBe("ready");
			expect(process.umask()).toBe(hostUmask);
			const storage = join(root, ".codegraph");
			expect((await lstat(storage)).mode & 0o077).toBe(0);
			for (const name of await readdir(storage)) {
				expect((await lstat(join(storage, name))).mode & 0o077, name).toBe(0);
			}
		},
	);

	it.skipIf(process.platform === "win32").each(["directory", "database"] as const)(
		"rejects owner-owned but publicly readable storage %s",
		async (target) => {
			const root = await fixture();
			const storage = join(root, ".codegraph");
			if (target === "database") {
				const first = acquire(root);
				await waitUntilSettled(first);
				expect(first.status().state).toBe("ready");
				first.dispose();
				await first.disposed;
				await chmod(join(storage, "codegraph.db"), 0o644);
			} else {
				await mkdir(storage, { mode: 0o700 });
				await chmod(storage, 0o755);
			}
			const service = acquire(root);
			await waitUntilSettled(service);
			expect(service.status().state).not.toBe("ready");
			expect(service.status().lastError).toContain("Unsafe CodeGraph storage permissions");
		},
	);

	it("fails closed before indexing symlink names unsafe in gitignore patterns", async () => {
		const names = ["wild*.ts", "question?.ts", "bracket[.ts", "!negated.ts", "control\u0001.ts", "line\nbreak.ts"];
		for (const name of names) {
			const root = await fixture();
			const outside = await mkdtemp(join(tmpdir(), "pi-codegraph-private-source-"));
			roots.push(outside);
			const secret = join(outside, "secret.ts");
			await writeFile(secret, "export const SYNTHETIC_SYMLINK_PRIVATE_MARKER = 1;\n");
			await symlink(secret, join(root, name));

			const service = acquire(root);
			await waitUntilSettled(service);
			expect(service.status().state, JSON.stringify({ name, status: service.status() })).not.toBe("ready");
			if (existsSync(join(root, ".codegraph", "codegraph.db"))) {
				expect(indexedPaths(root)).not.toContain(name);
			}
		}
	});

	it("rejects a leading-negation symlink name before it can defeat its own exclude", async () => {
		const root = await fixture();
		const outside = await mkdtemp(join(tmpdir(), "pi-codegraph-negated-source-"));
		roots.push(outside);
		const secret = join(outside, "secret.ts");
		await writeFile(secret, "export const SYNTHETIC_NEGATION_PRIVATE_MARKER = 1;\n");
		await symlink(secret, join(root, "!negated.ts"));

		const service = acquire(root);
		await waitUntilSettled(service);
		if (existsSync(join(root, ".codegraph", "codegraph.db"))) {
			expect(indexedPaths(root)).not.toContain("!negated.ts");
		}
		expect(service.status().state).not.toBe("ready");
	});

	it("does not follow a source path replaced by a symlink during snippet reads", async () => {
		const root = await fixture();
		const service = acquire(root);
		await waitUntilSettled(service);
		expect(service.status().state).toBe("ready");
		const outside = await mkdtemp(join(tmpdir(), "pi-codegraph-snippet-source-"));
		roots.push(outside);
		await writeFile(join(outside, "private.ts"), "export function SYNTHETIC_SOURCE_READ_MARKER() {}\n");
		await rm(join(root, "src", "entry.ts"));
		await symlink(join(outside, "private.ts"), join(root, "src", "entry.ts"));

		const result = await service.query({ operation: "context", name: "safeEntry", includeCode: true });
		expect(JSON.stringify(result.snippets)).not.toContain("SYNTHETIC_SOURCE_READ_MARKER");
	});

	it("keeps previous Pi exclusions when same pattern later appears user-owned", async () => {
		const root = await fixture();
		const adopted = "private-source.ts";
		await writeFile(join(root, adopted), "export const privateMarker = 1;\n");
		await writeFile(join(root, "codegraph.json"), JSON.stringify({ exclude: [adopted] }));
		await mkdir(join(root, ".codegraph"), { mode: 0o700 });
		await writeFile(
			join(root, ".codegraph", "pi-policy.json"),
			JSON.stringify({ version: 1, ownedExcludes: [adopted], exclude: [adopted] }),
			{ mode: 0o600 },
		);

		const service = acquire(root);
		await waitUntilSettled(service);
		const config = JSON.parse(await readFile(join(root, "codegraph.json"), "utf8")) as { exclude: string[] };
		expect(config.exclude).toContain(adopted);
		expect(indexedPaths(root)).not.toContain(adopted);
	});

	it("revalidates project storage before syncing after storage path replacement", async () => {
		const root = await fixture();
		const service = acquire(root);
		await waitUntilSettled(service);
		expect(service.status().state).toBe("ready");
		const storage = join(root, ".codegraph");
		const movedStorage = join(root, ".codegraph-original");
		await rename(storage, movedStorage);
		await symlink(movedStorage, storage);
		const status = await service.refresh();
		await waitUntilSettled(service);
		expect(status.state).not.toBe("ready");
	});
});
