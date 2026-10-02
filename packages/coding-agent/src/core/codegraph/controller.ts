import { type ChildProcess, fork } from "node:child_process";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, parse, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getCodegraphWorkerSpecifier } from "../../config.ts";
import { boundCodebaseResult } from "./format.ts";
import {
	CODEBASE_DEFAULT_LIMIT,
	CODEBASE_MAX_BYTES,
	CODEBASE_MAX_DEPTH,
	CODEBASE_MIN_BYTES,
	type CodebaseRequest,
	type CodebaseResult,
	type CodegraphOptions,
	type CodegraphService,
	type CodegraphStatus,
} from "./types.ts";

interface WorkerMessage {
	type?: "ready" | "status" | "fatal";
	id?: number;
	status?: Partial<CodegraphStatus>;
	result?: CodebaseResult | CodegraphStatus;
	error?: string;
	watcherHealth?: CodegraphStatus["watcher"];
	pendingChanges?: number;
}

interface Controller {
	root: string;
	settingsFingerprint: string;
	owners: number;
	child?: ChildProcess;
	status: CodegraphStatus;
	ready: Promise<void>;
	resolveReady: () => void;
	rejectReady: (error: Error) => void;
	disposed: Promise<void>;
	resolveDisposed: () => void;
	pending: Map<number, { resolve: (value: WorkerMessage) => void; reject: (error: Error) => void }>;
	queue: Promise<void>;
	refreshPromise?: Promise<CodegraphStatus>;
	nextId: number;
	stopping: boolean;
	exited: boolean;
}

const controllers = new Map<string, Controller>();

function emptyStatus(root: string, reason?: string): CodegraphStatus {
	return {
		enabled: false,
		eligible: false,
		root,
		storagePath: resolve(root, ".codegraph"),
		state: "disabled",
		revision: null,
		freshness: "unavailable",
		partial: true,
		lastSuccess: null,
		watcher: "off",
		pendingChanges: 0,
		activeOperation: null,
		counts: { files: 0, nodes: 0, edges: 0 },
		lastError: null,
		...(reason ? { reason } : {}),
	};
}

function canonicalRoots(options: CodegraphOptions): { cwd: string; root: string; reason?: string } {
	const cwd = realpathSync(options.cwd);
	const home = realpathSync(homedir());
	if (cwd === parse(cwd).root || cwd === home) return { cwd, root: cwd, reason: "Root indexing is disabled" };
	if (!options.grant) return { cwd, root: cwd, reason: "Explicit root-scoped CodeGraph grant required" };
	const granted = realpathSync(options.grant.root);
	if (granted !== cwd) return { cwd, root: cwd, reason: "Grant must match effective cwd exactly" };
	return { cwd, root: cwd };
}

function sanitizeDiagnostic(value: unknown, root: string): string {
	return String(value)
		.replaceAll(root, "<project>")
		.replace(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g, "<redacted-key>")
		.replace(/\bBearer\s+\S+/gi, "Bearer <redacted>")
		.replace(/((?:api[_-]?key|token|secret|password)\s*[:=]\s*)[^\s,;]+/gi, "$1<redacted>")
		.slice(-1000);
}

function statusFromMessage(controller: Controller, message: WorkerMessage): void {
	if (message.status) controller.status = { ...controller.status, ...message.status };
	if (message.watcherHealth) controller.status.watcher = message.watcherHealth;
	if (message.pendingChanges !== undefined) controller.status.pendingChanges = message.pendingChanges;
}

function request(controller: Controller, message: Record<string, unknown>): Promise<WorkerMessage> {
	const child = controller.child;
	if (!child?.connected || controller.exited || controller.stopping)
		return Promise.reject(new Error("CodeGraph worker is unavailable"));
	const id = ++controller.nextId;
	return new Promise((resolveMessage, rejectMessage) => {
		const deadline = setTimeout(() => {
			controller.pending.delete(id);
			const error = new Error("CodeGraph worker request exceeded 30-second deadline");
			controller.status = {
				...controller.status,
				state: "error",
				freshness: "stale",
				partial: true,
				activeOperation: null,
				lastError: error.message,
			};
			rejectMessage(error);
			// A stalled native operation cannot safely serve more queries or be drained.
			child.kill("SIGKILL");
		}, 30_000);
		deadline.unref();
		controller.pending.set(id, {
			resolve: (value) => {
				clearTimeout(deadline);
				resolveMessage(value);
			},
			reject: (error) => {
				clearTimeout(deadline);
				rejectMessage(error);
			},
		});
		child.send({ ...message, id }, (error) => {
			if (!error) return;
			controller.pending.get(id)?.reject(error);
			controller.pending.delete(id);
		});
	});
}

function terminate(controller: Controller): Promise<void> {
	if (controller.stopping) return controller.disposed;
	if (!controller.child || controller.exited) {
		controller.stopping = true;
		controller.rejectReady(new Error("CodeGraph worker stopped"));
		controller.status = {
			...controller.status,
			state: "disposed",
			enabled: false,
			activeOperation: null,
			watcher: "off",
		};
		controller.resolveDisposed();
		return controller.disposed;
	}
	controller.stopping = true;
	controller.rejectReady(new Error("CodeGraph worker stopped"));
	const child = controller.child;
	const timeout = setTimeout(() => child.kill("SIGKILL"), 5_000);
	timeout.unref();
	child.once("exit", () => {
		clearTimeout(timeout);
		controller.child = undefined;
		for (const pending of controller.pending.values()) pending.reject(new Error("CodeGraph worker stopped"));
		controller.pending.clear();
		controller.status = {
			...controller.status,
			state: "disposed",
			enabled: false,
			activeOperation: null,
			watcher: "off",
		};
		controller.resolveDisposed();
	});
	if (child.connected)
		child.send({ type: "shutdown" }, (error) => {
			if (error) child.kill("SIGTERM");
			else if (child.connected) child.disconnect();
		});
	else child.kill("SIGTERM");
	return controller.disposed;
}

function effectiveSettings(options: CodegraphOptions) {
	return {
		watch: options.settings?.watch !== false,
		debounceMs: Math.max(100, Math.min(5000, options.settings?.debounceMs ?? 250)),
		exclude: [...new Set(options.settings?.exclude ?? [])].sort(),
	};
}

function createController(root: string, options: CodegraphOptions, predecessor?: Promise<void>): Controller {
	let resolveReady!: () => void;
	let rejectReady!: (error: Error) => void;
	let resolveDisposed!: () => void;
	const ready = new Promise<void>((resolvePromise, rejectPromise) => {
		resolveReady = resolvePromise;
		rejectReady = rejectPromise;
	});
	const disposed = new Promise<void>((resolvePromise) => {
		resolveDisposed = resolvePromise;
	});
	void ready.catch(() => {});
	const settings = effectiveSettings(options);
	const controller: Controller = {
		root,
		settingsFingerprint: JSON.stringify(settings),
		owners: 0,
		status: {
			...emptyStatus(root),
			enabled: true,
			eligible: true,
			state: "starting",
			watcher: options.settings?.watch === false ? "off" : "starting",
		},
		ready,
		resolveReady,
		rejectReady,
		disposed,
		resolveDisposed,
		pending: new Map(),
		queue: Promise.resolve(),
		nextId: 0,
		stopping: false,
		exited: false,
	};
	const launch = () => {
		if (!controller.stopping) launchController(controller, settings);
	};
	if (predecessor) void predecessor.then(launch);
	else launch();
	return controller;
}

function launchController(controller: Controller, settings: ReturnType<typeof effectiveSettings>): void {
	const root = controller.root;
	const worker = getCodegraphWorkerSpecifier();
	if (!worker) {
		controller.status = {
			...controller.status,
			state: "disabled",
			enabled: false,
			eligible: false,
			reason: "Native CodeGraph worker is unavailable in this runtime",
		};
		controller.resolveReady();
		controller.resolveDisposed();
		return;
	}
	const env: NodeJS.ProcessEnv = {
		PATH: process.env.PATH,
		HOME: process.env.HOME,
		USERPROFILE: process.env.USERPROFILE,
		TMPDIR: process.env.TMPDIR,
		TEMP: process.env.TEMP,
		TMP: process.env.TMP,
		SystemRoot: process.env.SystemRoot,
		CODEGRAPH_DIR: ".codegraph",
		PI_CODEGRAPH_ROOT: root,
		PI_CODEGRAPH_WATCH: String(settings.watch),
		PI_CODEGRAPH_DEBOUNCE: String(settings.debounceMs),
		PI_CODEGRAPH_EXTRA_EXCLUDES: JSON.stringify(settings.exclude),
	};
	controller.child = fork(worker instanceof URL ? fileURLToPath(worker) : worker, [], {
		execArgv: ["--liftoff-only"],
		env,
		stdio: ["ignore", "pipe", "pipe", "ipc"],
	});
	const capture = (chunk: Buffer) => {
		const diagnostic = sanitizeDiagnostic(chunk.toString("utf8").trim(), root);
		if (diagnostic) controller.status.lastError = diagnostic;
	};
	controller.child.stdout?.on("data", capture);
	controller.child.stderr?.on("data", capture);
	let startupKillTimer: ReturnType<typeof setTimeout> | undefined;
	const clearStartupTimers = () => {
		clearTimeout(startupTimer);
		if (startupKillTimer) clearTimeout(startupKillTimer);
	};
	const startupTimer = setTimeout(() => {
		if (controller.status.state !== "starting") return;
		controller.status = {
			...controller.status,
			state: "error",
			lastError: "CodeGraph worker did not become ready before startup deadline",
		};
		controller.rejectReady(new Error(controller.status.lastError ?? "CodeGraph worker failed"));
		const child = controller.child;
		child?.kill("SIGTERM");
		startupKillTimer = setTimeout(() => {
			if (!controller.exited) child?.kill("SIGKILL");
		}, 5_000);
		startupKillTimer.unref();
	}, 60_000);
	startupTimer.unref();
	controller.child.on("message", (raw: unknown) => {
		if (!raw || typeof raw !== "object") return;
		const message = raw as WorkerMessage;
		if (message.type === "ready") {
			clearStartupTimers();
			controller.resolveReady();
			return;
		}
		if (message.type === "fatal") {
			clearStartupTimers();
			controller.status = {
				...controller.status,
				state: "error",
				activeOperation: null,
				lastError: message.error || "CodeGraph worker failed",
			};
			controller.rejectReady(new Error(controller.status.lastError ?? "CodeGraph worker failed"));
			return;
		}
		statusFromMessage(controller, message);
		if (message.id !== undefined) {
			const pending = controller.pending.get(message.id);
			if (pending) {
				controller.pending.delete(message.id);
				pending.resolve(message);
			}
		}
	});
	controller.child.once("error", (error) => {
		clearStartupTimers();
		controller.status = { ...controller.status, state: "error", lastError: error.message.slice(0, 500) };
		controller.rejectReady(error);
	});
	controller.child.once("exit", (code) => {
		controller.exited = true;
		clearStartupTimers();
		for (const pending of controller.pending.values())
			pending.reject(new Error(`CodeGraph worker exited (${code ?? "signal"})`));
		controller.pending.clear();
		if (!controller.stopping) {
			controller.status = {
				...controller.status,
				state: controller.status.state === "error" ? "error" : "degraded",
				activeOperation: null,
				freshness: "stale",
				lastError: controller.status.lastError || `CodeGraph worker exited (${code ?? "signal"})`,
			};
			controller.rejectReady(new Error(controller.status.lastError ?? "CodeGraph worker failed"));
		} else controller.resolveDisposed();
	});
}

function validateRequest(input: CodebaseRequest): { request?: CodebaseRequest; error?: string } {
	if (
		!input ||
		!["search", "symbols", "callers", "callees", "dependencies", "impact", "context"].includes(input.operation)
	)
		return { error: "Unknown operation" };
	if (
		input.maxBytes !== undefined &&
		(!Number.isInteger(input.maxBytes) || input.maxBytes < CODEBASE_MIN_BYTES || input.maxBytes > CODEBASE_MAX_BYTES)
	)
		return { error: `maxBytes must be between ${CODEBASE_MIN_BYTES} and ${CODEBASE_MAX_BYTES}` };
	if (
		input.limit !== undefined &&
		(!Number.isInteger(input.limit) || input.limit < 1 || input.limit > CODEBASE_DEFAULT_LIMIT)
	)
		return { error: `limit must be between 1 and ${CODEBASE_DEFAULT_LIMIT}` };
	if (
		input.depth !== undefined &&
		(!Number.isInteger(input.depth) || input.depth < 0 || input.depth > CODEBASE_MAX_DEPTH)
	)
		return { error: `depth must be between 0 and ${CODEBASE_MAX_DEPTH}` };
	if (input.offset !== undefined && (!Number.isInteger(input.offset) || input.offset < 0))
		return { error: "offset must be a non-negative integer" };
	if (input.query !== undefined && (typeof input.query !== "string" || input.query.length > 1_000))
		return { error: "query must be a string of at most 1000 characters" };
	if (input.name !== undefined && (typeof input.name !== "string" || input.name.length > 300))
		return { error: "name must be a string of at most 300 characters" };
	if (input.nodeId !== undefined && (typeof input.nodeId !== "string" || input.nodeId.length > 500))
		return { error: "nodeId must be a string of at most 500 characters" };
	if (input.includeCode !== undefined && typeof input.includeCode !== "boolean")
		return { error: "includeCode must be a boolean" };
	if (input.direction !== undefined && input.direction !== "imports" && input.direction !== "dependents")
		return { error: "direction must be imports or dependents" };
	if (
		input.file !== undefined &&
		(typeof input.file !== "string" ||
			!input.file ||
			input.file.length > 1024 ||
			isAbsolute(input.file) ||
			input.file.split(/[\\/]/).includes(".."))
	)
		return { error: "file must be a safe project-relative path of at most 1024 characters" };
	return {
		request: {
			...input,
			limit: input.limit ?? CODEBASE_DEFAULT_LIMIT,
			depth: input.depth ?? 1,
			maxBytes: input.maxBytes ?? CODEBASE_MAX_BYTES,
		},
	};
}

function unavailableResult(
	root: string,
	request: CodebaseRequest,
	status: CodegraphStatus,
	code: CodebaseResult["status"],
	notice: string,
): CodebaseResult {
	const maxBytes =
		Number.isInteger(request.maxBytes) &&
		request.maxBytes! >= CODEBASE_MIN_BYTES &&
		request.maxBytes! <= CODEBASE_MAX_BYTES
			? request.maxBytes!
			: CODEBASE_MAX_BYTES;
	return boundCodebaseResult(
		{
			status: code,
			operation: request.operation,
			...(request.operation === "dependencies"
				? { direction: request.direction === "dependents" ? "dependents" : "imports" }
				: {}),
			root,
			revision: status.revision,
			freshness: status.freshness,
			partial: status.partial,
			nodes: [],
			edges: [],
			files: [],
			snippets: [],
			limits: { results: request.limit ?? CODEBASE_DEFAULT_LIMIT, depth: request.depth ?? 0, maxBytes },
			truncated: false,
			notice,
		},
		maxBytes,
	);
}

function withSignal<T>(operation: Promise<T>, signal: AbortSignal | undefined, cancelled: () => T): Promise<T> {
	if (!signal) return operation;
	if (signal.aborted) return Promise.resolve(cancelled());
	return new Promise<T>((resolvePromise, rejectPromise) => {
		const onAbort = () => resolvePromise(cancelled());
		signal.addEventListener("abort", onAbort, { once: true });
		operation.then(resolvePromise, rejectPromise).finally(() => signal.removeEventListener("abort", onAbort));
	});
}

export function acquireCodegraph(options: CodegraphOptions): CodegraphService {
	let roots: ReturnType<typeof canonicalRoots>;
	try {
		roots = canonicalRoots(options);
	} catch {
		roots = {
			cwd: resolve(options.cwd),
			root: resolve(options.cwd),
			reason: "Project root does not exist or cannot be resolved",
		};
	}
	let controller = controllers.get(roots.root);
	const predecessor = controller?.stopping ? controller.disposed : undefined;
	if (predecessor) controller = undefined;
	const invalidSettings =
		options.settings?.exclude !== undefined &&
		(!Array.isArray(options.settings.exclude) ||
			options.settings.exclude.some((pattern) => typeof pattern !== "string"));
	const conflictingSettings =
		controller && !invalidSettings && controller.settingsFingerprint !== JSON.stringify(effectiveSettings(options));
	const reason =
		options.settings?.enabled === false
			? "Disabled by settings"
			: roots.reason ||
				(invalidSettings ? "Invalid codegraph.exclude: expected an array of strings" : undefined) ||
				(conflictingSettings
					? "Active CodeGraph owner uses different settings; release all owners before changing policy"
					: undefined);
	if (reason) {
		const status = emptyStatus(roots.root, reason);
		status.eligible = !roots.reason;
		return {
			status: () => ({ ...status }),
			query: async (input) => {
				const validated = validateRequest(input);
				if (!validated.request)
					return unavailableResult(
						roots.root,
						input,
						status,
						"invalid_request",
						validated.error || "Invalid request",
					);
				return unavailableResult(
					roots.root,
					validated.request,
					status,
					options.settings?.enabled === false || invalidSettings || conflictingSettings
						? "disabled"
						: "authorization_required",
					status.reason || "CodeGraph is disabled",
				);
			},
			refresh: async () => ({ ...status }),
			dispose: () => {},
			disposed: Promise.resolve(),
		};
	}
	if (!controller) {
		controller = createController(roots.root, options, predecessor);
		controllers.set(roots.root, controller);
	}
	controller.owners++;
	const owned = controller;
	let disposed = false;
	const leaseAbort = new AbortController();
	let resolveLeaseDisposed!: () => void;
	const leaseDisposed = new Promise<void>((resolvePromise) => {
		resolveLeaseDisposed = resolvePromise;
	});
	const service: CodegraphService = {
		status: () => (disposed ? { ...owned.status, enabled: false, state: "disposed" } : { ...owned.status }),
		query: async (input, signal) => {
			const validated = validateRequest(input);
			if (!validated.request)
				return unavailableResult(
					roots.root,
					input,
					owned.status,
					"invalid_request",
					validated.error || "Invalid request",
				);
			const combinedSignal = signal ? AbortSignal.any([signal, leaseAbort.signal]) : leaseAbort.signal;
			if (disposed || combinedSignal.aborted)
				return unavailableResult(
					roots.root,
					validated.request,
					owned.status,
					"cancelled",
					"Request cancelled or lease disposed",
				);
			if (owned.status.state === "error" || owned.status.state === "degraded")
				return unavailableResult(
					roots.root,
					validated.request,
					owned.status,
					"error",
					owned.status.lastError || "CodeGraph worker is degraded",
				);
			if (owned.status.state === "disabled")
				return unavailableResult(
					roots.root,
					validated.request,
					owned.status,
					"disabled",
					owned.status.reason || "CodeGraph is unavailable in this runtime",
				);
			if (owned.status.state !== "ready" && owned.status.state !== "refreshing")
				return unavailableResult(
					roots.root,
					validated.request,
					owned.status,
					"not_ready",
					"Initial index is not complete",
				);
			const operation = owned.queue.then(async () => {
				if (disposed || combinedSignal.aborted)
					return unavailableResult(
						roots.root,
						validated.request!,
						owned.status,
						"cancelled",
						"Request cancelled or lease disposed",
					);
				try {
					const result = await request(owned, { type: "query", request: validated.request });
					if (disposed || combinedSignal.aborted)
						return unavailableResult(
							roots.root,
							validated.request!,
							owned.status,
							"cancelled",
							"Request cancelled or lease disposed",
						);
					if (result.error)
						return unavailableResult(roots.root, validated.request!, owned.status, "error", result.error);
					if (!result.result || !("operation" in result.result))
						return unavailableResult(
							roots.root,
							validated.request!,
							owned.status,
							"error",
							"CodeGraph worker returned an invalid response",
						);
					return boundCodebaseResult(
						result.result as CodebaseResult,
						validated.request!.maxBytes!,
						validated.request!.offset,
					);
				} catch (error) {
					return unavailableResult(
						roots.root,
						validated.request!,
						owned.status,
						"error",
						sanitizeDiagnostic(error, roots.root),
					);
				}
			});
			owned.queue = operation.then(
				() => undefined,
				() => undefined,
			);
			return withSignal(operation, combinedSignal, () =>
				unavailableResult(
					roots.root,
					validated.request!,
					owned.status,
					"cancelled",
					disposed ? "Lease disposed" : "Request cancelled",
				),
			);
		},
		refresh: async (signal) => {
			const combinedSignal = signal ? AbortSignal.any([signal, leaseAbort.signal]) : leaseAbort.signal;
			if (disposed || combinedSignal.aborted) return { ...owned.status, lastError: "Refresh cancelled" };
			if (!owned.child || owned.exited || owned.status.state === "starting" || owned.status.state === "indexing")
				return { ...owned.status };
			let operation = owned.refreshPromise;
			if (!operation) {
				operation = owned.queue.then(async () => {
					try {
						await owned.ready;
						const response = await request(owned, { type: "refresh" });
						statusFromMessage(owned, response);
						if (response.result && "enabled" in response.result) owned.status = response.result;
					} catch (error) {
						owned.status = {
							...owned.status,
							state: "degraded",
							lastError: sanitizeDiagnostic(error, roots.root),
						};
					}
					return { ...owned.status };
				});
				owned.refreshPromise = operation;
				owned.queue = operation.then(
					() => undefined,
					() => undefined,
				);
				void operation.then(() => {
					if (owned.refreshPromise === operation) owned.refreshPromise = undefined;
				});
			}
			return withSignal(operation, combinedSignal, () => ({
				...owned.status,
				lastError: disposed ? "Lease disposed" : "Refresh cancelled",
			}));
		},
		dispose: () => {
			if (disposed) return;
			disposed = true;
			leaseAbort.abort();
			owned.owners--;
			if (owned.owners === 0) {
				void terminate(owned).then(
					() => {
						if (controllers.get(owned.root) === owned) controllers.delete(owned.root);
						resolveLeaseDisposed();
					},
					(error: unknown) => {
						owned.status.lastError = String(error).slice(0, 500);
						owned.resolveDisposed();
						if (controllers.get(owned.root) === owned) controllers.delete(owned.root);
						resolveLeaseDisposed();
					},
				);
			} else resolveLeaseDisposed();
		},
		disposed: leaseDisposed,
	};
	return service;
}
