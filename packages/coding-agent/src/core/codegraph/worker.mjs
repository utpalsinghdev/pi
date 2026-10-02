import { lstat, mkdir, open, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { watch as watchFs } from "node:fs";
import { createRequire } from "node:module";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

// This private child owns all engine writes; never change the host process's umask.
process.umask(0o077);
const root = resolve(process.env.PI_CODEGRAPH_ROOT || "");
const storage = resolve(root, ".codegraph");
const configPath = resolve(root, "codegraph.json");
const policyPath = resolve(storage, "pi-policy.json");
const incompletePath = resolve(storage, "pi-incomplete.json");
const workerId = process.pid;
const requiredExcludes = [
	".codegraph/", ".env", ".env.*", "**/.env", "**/.env.*", "*.pem", "**/*.pem", "*.key", "**/*.key",
	"*.p12", "**/*.p12", "*.pfx", "**/*.pfx", "id_rsa*", "**/id_rsa*", "id_ed25519*", "**/id_ed25519*",
	".ssh/", "**/.ssh/", ".aws/", "**/.aws/", "auth.json", "**/auth.json", ".npmrc", "**/.npmrc", ".netrc", "**/.netrc",
	"node_modules/", "**/node_modules/", "dist/", "**/dist/", "build/", "**/build/", "coverage/", "**/coverage/",
];
let graph;
let watcher;
let syncPromise;
let initialPromise;
let startupPromise;
let debounceTimer;
let engineQueue = Promise.resolve();
const activeQueries = new Set();
let closed = false;
let watcherHealth = "off";
let pendingChanges = 0;
let status = { state: "starting", phase: undefined, revision: null, freshness: "unavailable", partial: true, lastSuccess: null, activeOperation: "index", counts: { files: 0, nodes: 0, edges: 0 }, lastError: null };
const send = (message) => process.send?.(message);
const inside = (base, path) => {
	const rel = relative(base, path);
	return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};
const safeError = (error) => String(error?.message || error)
	.replaceAll(root, "<project>")
	.replace(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g, "<redacted-key>")
	.replace(/\bBearer\s+\S+/gi, "Bearer <redacted>")
	.replace(/((?:api[_-]?key|token|secret|password)\s*[:=]\s*)[^\s,;]+/gi, "$1<redacted>")
	.slice(0, 500);

async function assertOwnedPath(path, directory = false, privateState = false) {
	try {
		const info = await lstat(path);
		if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile())) throw new Error(`Unsafe CodeGraph storage path: ${basename(path)}`);
		if (typeof process.getuid === "function" && info.uid !== process.getuid()) throw new Error(`Unsafe CodeGraph storage owner: ${basename(path)}`);
		const unsafePermissions = (info.mode & (privateState ? 0o077 : 0o022)) !== 0;
		if (unsafePermissions || (!directory && info.nlink !== 1)) throw new Error(`Unsafe CodeGraph storage permissions: ${basename(path)}`);
	} catch (error) {
		if (error?.code !== "ENOENT") throw error;
	}
}

async function writePrivateState(path, value) {
	const handle = await open(path, constants.O_CREAT | constants.O_WRONLY | (constants.O_NOFOLLOW || 0), 0o600);
	try {
		const info = await handle.stat();
		if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o077) !== 0 || (typeof process.getuid === "function" && info.uid !== process.getuid())) throw new Error(`Unsafe CodeGraph state file: ${basename(path)}`);
		await handle.truncate(0);
		await handle.writeFile(value);
	} finally {
		await handle.close();
	}
}

async function prepareStorage() {
	const rootInfo = await lstat(root);
	if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error("Project root is not a safe directory");
	await assertOwnedPath(storage, true, true);
	await mkdir(storage, { recursive: true, mode: 0o700 });
	await assertOwnedPath(storage, true, true);
	for (const name of ["codegraph.db", "codegraph.db-wal", "codegraph.db-shm", "codegraph.db-journal", "codegraph.lock", "pi-policy.json", "pi-incomplete.json"]) {
		await assertOwnedPath(resolve(storage, name), false, true);
	}
}

async function discoverSymlinks(directory = root, found = []) {
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		if ([".git", ".codegraph", "node_modules", "dist", "build", "coverage", ".next", "target"].includes(entry.name)) continue;
		const path = resolve(directory, entry.name);
		if (!inside(root, path)) continue;
		if (entry.isSymbolicLink()) {
			const rel = relative(root, path).split(sep).join("/");
			if (/[\u0000-\u001f\u007f*?\[\]{}!#\\]/.test(rel)) throw new Error("Unsafe symlink path cannot be represented as a CodeGraph exclusion");
			found.push(rel, `${rel}/**`);
		}
		else if (entry.isDirectory()) await discoverSymlinks(path, found);
	}
	return found;
}

async function installPolicy() {
	await prepareStorage();
	let userConfig = {};
	try {
		await assertOwnedPath(configPath);
		const parsed = JSON.parse(await readFile(configPath, "utf8"));
		if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") throw new Error("codegraph.json must contain an object");
		userConfig = parsed;
	} catch (error) {
		if (error?.code !== "ENOENT") throw new Error(`Invalid codegraph.json: ${safeError(error)}`);
	}
	const extras = process.env.PI_CODEGRAPH_EXTRA_EXCLUDES ? JSON.parse(process.env.PI_CODEGRAPH_EXTRA_EXCLUDES) : [];
	if (!Array.isArray(extras) || extras.some((pattern) => typeof pattern !== "string" || !pattern.trim() || pattern.startsWith("!") || isAbsolute(pattern) || pattern.split(/[\\/]/).includes(".."))) throw new Error("Invalid additional CodeGraph excludes");
	let previousOwned = [];
	try {
		const marker = JSON.parse(await readFile(policyPath, "utf8"));
		if (marker?.version !== 1 || !Array.isArray(marker.ownedExcludes) || marker.ownedExcludes.some((pattern) => typeof pattern !== "string")) throw new Error("Invalid Pi CodeGraph policy marker");
		previousOwned = marker.ownedExcludes;
	} catch (error) {
		if (error?.code !== "ENOENT") throw error;
	}
	const symlinks = await discoverSymlinks();
	const userExcludes = Array.isArray(userConfig.exclude) ? userConfig.exclude : [];
	const ownedExcludes = [...new Set([...previousOwned, ...requiredExcludes, ...extras, ...symlinks])];
	const exclude = [...new Set([...userExcludes, ...ownedExcludes])];
	if (userConfig.exclude !== undefined && (!Array.isArray(userConfig.exclude) || userConfig.exclude.some((pattern) => typeof pattern !== "string"))) throw new Error("codegraph.json exclude must be an array of strings");
	if (exclude.length !== (Array.isArray(userConfig.exclude) ? userConfig.exclude.length : 0) || exclude.some((item, i) => item !== userConfig.exclude?.[i])) {
		const next = { ...userConfig, exclude };
		const temporary = `${configPath}.pi-${workerId}.tmp`;
		await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600, flag: "wx" });
		await rename(temporary, configPath);
	}
	excludedPaths = new Set(symlinks);
	excludedPatterns = exclude;
	for (const pattern of exclude) {
		if (pattern.includes("*") || pattern.endsWith("/")) continue;
		excludedPaths.add(pattern);
	}
	const fingerprint = JSON.stringify(exclude.slice().sort());
	await writePrivateState(policyPath, JSON.stringify({ version: 1, fingerprint, exclude, ownedExcludes, updatedAt: Date.now() }));
	return fingerprint;
}

function nodeData(node, score) {
	return { id: node.id, name: node.name, qualifiedName: node.qualifiedName, kind: node.kind, language: node.language, file: node.filePath, startLine: node.startLine, endLine: node.endLine, ...(score === undefined ? {} : { score }) };
}
function edgeData(edge) {
	return { source: edge.source, target: edge.target, kind: edge.kind, ...(edge.line === undefined ? {} : { line: edge.line }), provenance: edge.provenance || "unspecified" };
}
function validFile(file) {
	if (typeof file !== "string" || !file || isAbsolute(file) || file.split(/[\\/]/).includes("..")) return false;
	const absolute = resolve(root, file);
	return inside(root, absolute) && !file.split(/[\\/]/).some((part) => part === ".codegraph" || part === ".git");
}
function resolveNode(request) {
	if (request.nodeId) return graph.getNode(request.nodeId);
	const name = request.name || request.query;
	if (!name) return null;
	const candidates = graph.getNodesByName(name).filter((node) => !isExcluded(node.filePath) && (!request.file || node.filePath === request.file) && (!request.kind || node.kind === request.kind));
	return candidates.length === 1 ? candidates[0] : candidates;
}
function responseBase(request) {
	return { status: "ok", operation: request.operation, ...(request.operation === "dependencies" ? { direction: request.direction ?? "imports" } : {}), root, revision: status.revision, freshness: status.freshness, partial: status.partial, nodes: [], edges: [], files: [], snippets: [], limits: { results: request.limit || 20, depth: request.depth || 0, maxBytes: request.maxBytes || 8000 }, truncated: false };
}
async function query(request) {
	const out = responseBase(request);
	let found;
	if (request.operation === "search") {
		const matches = graph.searchNodes(request.query || "", { kinds: request.kind ? [request.kind] : undefined, languages: request.language ? [request.language] : undefined, limit: 1000 });
		const filtered = matches.filter(({ node }) => (!request.file || node.filePath === request.file) && !isExcluded(node.filePath));
		filtered.sort((a, b) => b.score - a.score || a.node.id.localeCompare(b.node.id));
		const unique = [...new Map(filtered.map((match) => [match.node.id, match])).values()];
		out.nodes = unique.slice(request.offset || 0, (request.offset || 0) + request.limit).map(({ node, score }) => nodeData(node, score));
		out.truncated = unique.length > (request.offset || 0) + out.nodes.length;
		if (out.truncated) out.nextOffset = (request.offset || 0) + out.nodes.length;
	} else if (request.operation === "symbols") {
		if (request.file && !validFile(request.file)) return { ...out, status: "invalid_request", notice: "Invalid project-relative file path" };
		const list = request.file ? graph.getNodesInFile(request.file) : request.name ? graph.getNodesByName(request.name) : [];
		const sorted = list.filter((node) => (!request.kind || node.kind === request.kind) && !isExcluded(node.filePath)).sort((a, b) => a.id.localeCompare(b.id));
		out.nodes = sorted.slice(request.offset || 0, (request.offset || 0) + request.limit).map((node) => nodeData(node));
		out.truncated = sorted.length > (request.offset || 0) + out.nodes.length;
		if (out.truncated) out.nextOffset = (request.offset || 0) + out.nodes.length;
	} else if (["callers", "callees", "impact", "context"].includes(request.operation)) {
		const contextSeeds = [];
		if (request.operation === "context" && !request.nodeId && !request.name && request.query) {
			const terms = [...new Set(request.query.split(/[^A-Za-z0-9_$]+/).filter(Boolean))].slice(0, 20);
			for (const term of terms) {
				const matches = graph.getNodesByName(term).filter((node) => !isExcluded(node.filePath) && (!request.file || node.filePath === request.file) && (!request.kind || node.kind === request.kind));
				if (matches.length > 1) return { ...out, status: "ambiguous", nodes: matches.slice(0, request.limit).map((node) => nodeData(node)), notice: `Specify file or nodeId to disambiguate ${term}` };
				if (matches.length === 1 && !contextSeeds.some((node) => node.id === matches[0].id)) contextSeeds.push(matches[0]);
			}
			if (contextSeeds.length === 0) return { ...out, status: "not_found", notice: "No exact indexed symbols found in context query" };
		} else {
			found = resolveNode(request);
			if (Array.isArray(found)) return { ...out, status: "ambiguous", nodes: found.slice(0, request.limit).map((node) => nodeData(node)), notice: "Specify nodeId or file to disambiguate" };
			if (!found || isExcluded(found.filePath)) return { ...out, status: "not_found", notice: "No matching indexed symbol" };
			contextSeeds.push(found);
		}
		const depth = request.depth ?? 1;
		if (request.operation === "context") {
			const nodes = new Map(contextSeeds.map((node) => [node.id, node]));
			const edges = new Map();
			const traversalLimit = Math.min(request.limit, 20);
			for (const seed of contextSeeds.slice(0, 5)) {
				const subgraph = graph.traverse(seed.id, { maxDepth: depth, limit: traversalLimit, includeStart: true });
				for (const node of subgraph.nodes.values()) if (!isExcluded(node.filePath)) nodes.set(node.id, node);
				for (const edge of subgraph.edges) {
					if (nodes.has(edge.source) || nodes.has(edge.target)) edges.set(`${edge.source}:${edge.target}:${edge.kind}`, edge);
				}
			}
			out.nodes = [...nodes.values()].sort((a, b) => a.id.localeCompare(b.id)).slice(0, request.limit).map((node) => nodeData(node));
			const allowed = new Set(out.nodes.map((node) => node.id));
			out.edges = [...edges.values()].filter((edge) => allowed.has(edge.source) && allowed.has(edge.target)).sort((a, b) => a.source.localeCompare(b.source) || a.target.localeCompare(b.target) || a.kind.localeCompare(b.kind)).slice(0, request.limit * 3).map(edgeData);
			out.truncated = contextSeeds.length > 5 || nodes.size > out.nodes.length || edges.size > out.edges.length;
		} else if (request.operation === "callers" || request.operation === "callees") {
			out.subject = nodeData(found);
			const relations = (request.operation === "callers" ? graph.getCallers(found.id, depth) : graph.getCallees(found.id, depth)).sort((a, b) => a.node.id.localeCompare(b.node.id));
			out.nodes = relations.filter(({ node }) => !isExcluded(node.filePath)).slice(0, request.limit).map(({ node }) => nodeData(node));
			const allowed = new Set([found.id, ...out.nodes.map((node) => node.id)]);
			out.edges = relations.filter(({ node, edge }) => allowed.has(node.id) && allowed.has(edge.source) && allowed.has(edge.target)).slice(0, request.limit).map(({ edge }) => edgeData(edge)).sort((a, b) => a.source.localeCompare(b.source) || a.target.localeCompare(b.target) || a.kind.localeCompare(b.kind));
			out.truncated = relations.length > out.nodes.length;
		} else {
			const subgraph = request.operation === "impact" ? graph.getImpactRadius(found.id, depth) : graph.traverse(found.id, { maxDepth: depth, limit: request.limit, includeStart: true });
			out.nodes = [...subgraph.nodes.values()].filter((node) => !isExcluded(node.filePath)).sort((a, b) => a.id.localeCompare(b.id)).slice(0, request.limit).map((node) => nodeData(node));
			const allowed = new Set(out.nodes.map((node) => node.id));
			out.edges = subgraph.edges.filter((edge) => allowed.has(edge.source) && allowed.has(edge.target)).sort((a, b) => a.source.localeCompare(b.source) || a.target.localeCompare(b.target) || a.kind.localeCompare(b.kind)).slice(0, request.limit * 3).map(edgeData);
			out.truncated = subgraph.nodes.size > out.nodes.length || subgraph.edges.length > out.edges.length;
			if (request.operation === "impact") out.notice = "Static graph neighborhood, not runtime tracing or Git-diff analysis.";
		}
		if (request.operation === "context" && request.includeCode) {
			for (const node of out.nodes.slice(0, 5)) {
				if (node.endLine - node.startLine > 100 || isExcluded(node.file)) continue;
				const code = await readSafeSource(node.file, node.startLine, node.endLine);
				if (code) out.snippets.push({ nodeId: node.id, file: node.file, startLine: node.startLine, endLine: node.endLine, code: code.slice(0, 1500), truncated: code.length > 1500 });
			}
		}
	} else if (request.operation === "dependencies") {
		if (!validFile(request.file)) return { ...out, status: "invalid_request", notice: "A safe project-relative file is required" };
		const origin = isExcluded(request.file) ? undefined : graph.getFileNodes([request.file])[0];
		if (!origin) return { ...out, status: "not_found", notice: "No matching indexed file" };
		out.subject = nodeData(origin);
		const files = (request.direction === "dependents" ? graph.getFileDependents(request.file) : graph.getFileDependencies(request.file)).filter((file) => validFile(file) && !isExcluded(file)).sort();
		out.files = files.slice(request.offset || 0, (request.offset || 0) + request.limit);
		out.truncated = files.length > (request.offset || 0) + out.files.length;
		if (out.truncated) out.nextOffset = (request.offset || 0) + out.files.length;
	} else return { ...out, status: "invalid_request", notice: "Unknown operation" };
	return out;
}

let excludedPaths = new Set();
let excludedPatterns = requiredExcludes;
function isExcluded(path) {
	if (excludedPaths.has(path) || /(^|\/)(\.env(?:\..*)?|\.ssh|\.aws|node_modules|\.codegraph)(\/|$)|(^|\/)(auth\.json|\.npmrc|\.netrc|[^/]+\.(?:pem|key|p12|pfx))$/i.test(path)) return true;
	const parts = path.split("/");
	return excludedPatterns.some((pattern) => {
		const source = pattern.replaceAll("\\", "/").replace(/^\//, "");
		const directory = source.endsWith("/");
		const glob = source.replace(/\/$/, "").replaceAll("**/", "\u0001").replace(/[.+^${}()|[\]\\]/g, "\\$&").replaceAll("**", "\u0002").replaceAll("*", "[^/]*").replaceAll("\u0001", "(?:.*/)?").replaceAll("\u0002", ".*");
		const expression = new RegExp(`^${glob}$`, "i");
		if (!source.includes("/")) return parts.some((part, index) => expression.test(part) && (!directory || index < parts.length - 1));
		return parts.some((_, index) => {
			const candidate = parts.slice(index).join("/");
			return expression.test(candidate) || (directory && candidate.startsWith(`${source.replace(/\/$/, "")}/`));
		});
	});
}
async function readSafeSource(file, startLine, endLine) {
	if (!validFile(file) || isExcluded(file)) return "";
	let current = root;
	for (const part of file.split(/[\\/]/)) {
		current = resolve(current, part);
		const info = await lstat(current);
		if (info.isSymbolicLink() || !inside(root, current)) return "";
	}
	const handle = await open(current, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
	try {
		const info = await handle.stat();
		if (!info.isFile()) return "";
		const chunk = Buffer.alloc(64 * 1024);
		const lines = [];
		let offset = 0;
		let lineNumber = 1;
		let pending = "";
		while (offset < 1024 * 1024 && lineNumber <= endLine) {
			const { bytesRead } = await handle.read(chunk, 0, chunk.length, offset);
			if (!bytesRead) break;
			offset += bytesRead;
			pending += chunk.toString("utf8", 0, bytesRead);
			const complete = pending.split(/\r?\n/);
			pending = complete.pop() || "";
			for (const line of complete) {
				if (lineNumber >= startLine) lines.push(line);
				lineNumber++;
				if (lineNumber > endLine) break;
			}
		}
		if (lineNumber <= endLine && offset < 1024 * 1024 && lineNumber >= startLine && pending) lines.push(pending);
		return lines.join("\n");
	} finally {
		await handle.close();
	}
}

function serialize(operation) {
	const result = engineQueue.then(operation);
	engineQueue = result.then(() => undefined, () => undefined);
	return result;
}

function refresh() {
	if (syncPromise) return syncPromise;
	syncPromise = serialize(performRefresh).finally(() => { syncPromise = undefined; });
	return syncPromise;
}

async function performRefresh() {
	if (initialPromise) await initialPromise;
	const pendingAtStart = pendingChanges;
	status = { ...status, state: "refreshing", activeOperation: "refresh", freshness: "stale" };
	try {
		const beforePolicy = await installPolicy();
		await writePrivateState(incompletePath, JSON.stringify({ startedAt: Date.now(), pid: workerId }));
		const result = await graph.sync({ onProgress: (progress) => { status.phase = { name: progress.phase, current: progress.current, total: progress.total }; send({ type: "status", status, watcherHealth, pendingChanges }); } });
		const afterPolicy = await installPolicy();
		const reconcile = beforePolicy === afterPolicy ? undefined : await graph.sync({ onProgress: (progress) => { status.phase = { name: progress.phase, current: progress.current, total: progress.total }; send({ type: "status", status, watcherHealth, pendingChanges }); } });
		let finalPolicy = await installPolicy();
		let pendingObserved = pendingAtStart;
		let retries = 0;
		while (pendingChanges > pendingObserved && retries < 2) {
			pendingObserved = pendingChanges;
			retries++;
			const retry = await graph.sync({ onProgress: (progress) => { status.phase = { name: progress.phase, current: progress.current, total: progress.total }; send({ type: "status", status, watcherHealth, pendingChanges }); } });
			if (retry.failedFilePaths?.length) result.failedFilePaths = retry.failedFilePaths;
			finalPolicy = await installPolicy();
		}
		const missedChanges = pendingChanges > pendingObserved;
		const partial = !!result.failedFilePaths?.length || !!reconcile?.failedFilePaths?.length || finalPolicy !== afterPolicy || missedChanges;
		status = { ...status, state: partial ? "degraded" : "ready", activeOperation: null, phase: undefined, freshness: partial ? "stale" : "current", partial, pendingChanges: missedChanges ? pendingChanges : 0, lastSuccess: partial ? status.lastSuccess : Date.now(), lastError: partial ? "Some files could not be indexed or changes remain pending" : null };
		if (!partial) await rm(incompletePath, { force: true });
		await updateCounts();
	} catch (error) {
		status = { ...status, state: "degraded", activeOperation: null, freshness: "stale", lastError: safeError(error) };
	}
	if (!status.partial) pendingChanges = 0;
	send({ type: "status", status, watcherHealth, pendingChanges });
	return status;
}
async function updateCounts() {
	const stats = graph.getStats();
	status.counts = { files: stats.fileCount, nodes: stats.nodeCount, edges: stats.edgeCount };
	status.revision = { lastIndexedAt: stats.lastUpdated || null, fileCount: stats.fileCount };
}
async function start() {
	if (!root || !isAbsolute(root) || root === "/" || root === process.env.HOME) throw new Error("CodeGraph root is not eligible");
	await prepareStorage();
	await installPolicy();
	const require = createRequire(import.meta.url);
	const platformPackage = `@colbymchenry/codegraph-${process.platform}-${process.arch}`;
	require.resolve(`${platformPackage}/lib/dist/index.js`);
	const { CodeGraph } = require("@colbymchenry/codegraph");
	graph = CodeGraph.isInitialized(root) ? await CodeGraph.open(root) : await CodeGraph.init(root);
	const wasInterrupted = await lstat(incompletePath).then(() => true, (error) => error?.code === "ENOENT" ? false : Promise.reject(error));
	await writePrivateState(incompletePath, JSON.stringify({ startedAt: Date.now(), pid: workerId }));
	const indexed = graph.getStats().fileCount > 0;
	status.partial = wasInterrupted;
	status.state = indexed ? "refreshing" : "indexing";
	status.activeOperation = indexed ? "refresh" : "index";
	status.freshness = indexed ? "stale" : "unavailable";
	await updateCounts();
	const initialPolicy = await installPolicy();
	const onProgress = (progress) => {
		status.phase = { name: progress.phase, current: progress.current, total: progress.total };
		send({ type: "status", status, watcherHealth, pendingChanges });
	};
	const initialEngine = indexed ? graph.sync({ onProgress }) : graph.indexAll({ onProgress });
	initialPromise = (async () => {
		try {
			const result = await initialEngine;
			const afterInitialPolicy = await installPolicy();
			const reconcile = initialPolicy === afterInitialPolicy ? undefined : await graph.sync({ onProgress });
			const finalPolicy = await installPolicy();
			const failed = result.failedFilePaths?.length || result.errors?.length || (result.filesDiscovered !== undefined && result.filesIndexed + result.filesSkipped + result.filesErrored !== result.filesDiscovered) || reconcile?.failedFilePaths?.length || finalPolicy !== afterInitialPolicy;
			status = { ...status, state: failed ? "degraded" : "ready", activeOperation: null, phase: undefined, freshness: failed ? "stale" : "current", partial: !!failed, lastSuccess: failed ? null : Date.now(), lastError: failed ? "Initial index or privacy-policy reconciliation was partial" : null };
			if (!failed) await rm(incompletePath, { force: true });
			await updateCounts();
		} catch (error) {
			status = { ...status, state: "error", activeOperation: null, freshness: "stale", lastError: safeError(error) };
		}
		send({ type: "status", status, watcherHealth, pendingChanges });
	})();
	void initialPromise.then(() => { initialPromise = undefined; });
	try {
		if (process.env.PI_CODEGRAPH_WATCH !== "false") {
			watcher = watchFs(root, { recursive: true }, (_event, filename) => {
				const relativePath = filename?.toString().replaceAll("\\", "/");
				if (relativePath && isExcluded(relativePath)) return;
				pendingChanges++;
				if (status.state === "ready") status = { ...status, freshness: "stale" };
				send({ type: "status", status, watcherHealth, pendingChanges });
				clearTimeout(debounceTimer);
				debounceTimer = setTimeout(() => { if (!closed) void refresh(); }, Number(process.env.PI_CODEGRAPH_DEBOUNCE || 350));
			});
			watcher.on("error", (error) => {
				watcherHealth = "degraded";
				status.lastError = safeError(error);
				send({ type: "status", status, watcherHealth, pendingChanges });
			});
			watcherHealth = "healthy";
		}
	} catch (error) { watcherHealth = "degraded"; status.lastError = safeError(error); }
	await updateCounts();
}
async function shutdown() {
	closed = true;
	clearTimeout(debounceTimer);
	await startupPromise?.catch(() => {});
	watcher?.close();
	if (initialPromise) await initialPromise.catch(() => {});
	if (syncPromise) await syncPromise;
	await Promise.all(activeQueries);
	await engineQueue;
	graph?.unwatch();
	graph?.close();
	process.disconnect?.();
}

process.on("message", async (message) => {
	if (message?.type === "query") {
		const operation = serialize(() => query(message.request));
		activeQueries.add(operation);
		try { send({ id: message.id, result: await operation }); }
		catch (error) { send({ id: message.id, error: safeError(error) }); }
		finally { activeQueries.delete(operation); }
	} else if (message?.type === "refresh") {
		const result = await refresh();
		send({ id: message.id, result: { ...status, watcher: watcherHealth, pendingChanges } });
	} else if (message?.type === "status") send({ id: message.id, result: { ...status, watcher: watcherHealth, pendingChanges } });
	else if (message?.type === "shutdown") await shutdown();
});

startupPromise = start();
startupPromise.then(() => { if (!closed) send({ type: "ready" }); }).catch((error) => {
	send({ type: "fatal", error: safeError(error) });
	process.exitCode = 1;
	process.disconnect?.();
});
