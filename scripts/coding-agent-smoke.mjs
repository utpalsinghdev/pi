import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const codingAgentName = "@earendil-works/pi-coding-agent";

export function smokeTestCodingAgent(directory, runtime = process.execPath, { codegraph = !process.versions.bun && runtime === process.execPath } = {}) {
	const packageDir = join(directory, "node_modules", codingAgentName);
	const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
	const home = mkdtempSync(join(tmpdir(), "pi-coding-agent-smoke-home-"));
	const project = codegraph ? mkdtempSync(join(directory, "codegraph-project-")) : undefined;
	const entry = join(directory, "coding-agent-smoke.mjs");
	const env = {
		PATH: process.env.PATH,
		HOME: home,
		USERPROFILE: home,
		APPDATA: home,
		LOCALAPPDATA: home,
		XDG_CONFIG_HOME: home,
		XDG_CACHE_HOME: home,
		PI_CODING_AGENT_DIR: join(home, ".pi", "agent"),
		PI_OFFLINE: "1",
		PI_NO_LOCAL_LLM: "1",
		PI_TELEMETRY: "0",
		...(project ? { PI_CODEGRAPH_SMOKE_PROJECT: project } : {}),
	};
	for (const name of ["SystemRoot", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT"]) {
		if (process.env[name]) env[name] = process.env[name];
	}
	try {
		if (project) cpSync(new URL("../docs/native-codegraph-artifacts/track-c/fixtures/", import.meta.url), project, { recursive: true });
		writeFileSync(entry, `import assert from "node:assert/strict";
import { createAgentSession, SessionManager, ModelRuntime } from "${codingAgentName}";
assert.equal(typeof createAgentSession, "function");
assert.equal(typeof SessionManager.inMemory, "function");
assert.equal(typeof ModelRuntime.create, "function");
${codegraph ? `const cwd = process.env.PI_CODEGRAPH_SMOKE_PROJECT;
assert.ok(cwd, "CodeGraph smoke must receive its isolated fixture root");
const { session } = await createAgentSession({
  cwd,
  agentDir: process.env.PI_CODING_AGENT_DIR,
  codegraph: { root: cwd },
  sessionManager: SessionManager.inMemory(cwd),
});
let providerCalls = 0;
session.modelRuntime.streamSimple = () => {
  providerCalls++;
  throw new Error("unexpected provider request in offline CodeGraph smoke");
};
const events = [];
const unsubscribe = session.subscribe((event) => events.push(event));
try {
  const tool = session.agent.state.tools.find((item) => item.name === "codebase");
  assert.ok(tool, "authorized SDK session must expose installed native codebase tool");
  const deadline = Date.now() + 120_000;
  let result;
  while (Date.now() < deadline) {
    const outcome = await tool.execute("installed-codegraph-smoke", { operation: "search", query: "createOrder" });
    const payload = outcome.content.find((part) => part.type === "text");
    assert.ok(payload && payload.type === "text", "codebase tool must return serialized text result");
    result = JSON.parse(payload.text);
    if (result.status === "ok") break;
    assert.equal(result.status, "not_ready", JSON.stringify(result));
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.ok(result?.status === "ok", "native tool did not reach indexed readiness before deadline");
  assert.ok(result.nodes.some((node) => node.name === "createOrder"), JSON.stringify(result));
  await session.prompt("/codegraph status");
  await session.prompt("/codegraph refresh");
  assert.ok(events.some((event) => event.type === "codegraph_result" && event.command === "status"));
  assert.ok(events.some((event) => event.type === "codegraph_result" && event.command === "refresh"));
  assert.equal(providerCalls, 0, "status and refresh must not issue provider requests");
} finally {
  unsubscribe();
  await session.disposeAsync();
}` : ""}
`);
		execFileSync(runtime, [entry], { cwd: directory, env, stdio: ["inherit", "pipe", "pipe"], timeout: codegraph ? 150_000 : 30_000 });
		for (const cli of new Set([manifest.bin.pi, "dist/cli.js"])) {
			const output = execFileSync(runtime, [join(packageDir, cli), "--version"], {
				cwd: directory,
				encoding: "utf8",
				env,
				stdio: ["inherit", "pipe", "pipe"],
				timeout: 30_000,
			});
			if (output.trim() !== manifest.version) throw new Error(`Unexpected version from ${cli}: ${output}`);
		}
	} finally {
		rmSync(entry, { force: true });
		if (project) rmSync(project, { recursive: true, force: true });
		rmSync(home, { recursive: true, force: true });
	}
	console.log(`Coding-agent SDK and CLI${codegraph ? " and native CodeGraph" : ""} smoke tests passed (${runtime}).`);
}
