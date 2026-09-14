import { type ExecFileException, execFile, spawnSync } from "child_process";
import { existsSync, type FSWatcher, readFileSync, type Stats, statSync, unwatchFile, watchFile } from "fs";
import { dirname, join, resolve } from "path";
import { closeWatcher, FS_WATCH_RETRY_DELAY_MS, watchWithErrorHandler } from "../utils/fs-watch.ts";

export type GitPaths = {
	repoDir: string;
	commonGitDir: string;
	headPath: string;
};

export type GitDiffStats = {
	filesChanged: number;
	insertions: number;
	deletions: number;
};

const EMPTY_GIT_DIFF_STATS: GitDiffStats = {
	filesChanged: 0,
	insertions: 0,
	deletions: 0,
};

/**
 * Find git metadata paths by walking up from cwd.
 * Handles both regular git repos (.git is a directory) and worktrees (.git is a file).
 */
export function findGitPaths(cwd: string): GitPaths | null {
	let dir = cwd;
	while (true) {
		const gitPath = join(dir, ".git");
		if (existsSync(gitPath)) {
			try {
				const stat = statSync(gitPath);
				if (stat.isFile()) {
					const content = readFileSync(gitPath, "utf8").trim();
					if (content.startsWith("gitdir: ")) {
						const gitDir = resolve(dir, content.slice(8).trim());
						const headPath = join(gitDir, "HEAD");
						if (!existsSync(headPath)) return null;
						const commonDirPath = join(gitDir, "commondir");
						const commonGitDir = existsSync(commonDirPath)
							? resolve(gitDir, readFileSync(commonDirPath, "utf8").trim())
							: gitDir;
						return { repoDir: dir, commonGitDir, headPath };
					}
				} else if (stat.isDirectory()) {
					const headPath = join(gitPath, "HEAD");
					if (!existsSync(headPath)) return null;
					return { repoDir: dir, commonGitDir: gitPath, headPath };
				}
			} catch {
				return null;
			}
		}
		const parent = dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

/** Ask git for the current branch. Returns null on detached HEAD or if git is unavailable. */
function resolveBranchWithGitSync(repoDir: string): string | null {
	const result = spawnSync("git", ["--no-optional-locks", "symbolic-ref", "--quiet", "--short", "HEAD"], {
		cwd: repoDir,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
	});
	const branch = result.status === 0 ? result.stdout.trim() : "";
	return branch || null;
}

/** Ask git for the current branch asynchronously. Returns null on detached HEAD or if git is unavailable. */
function resolveBranchWithGitAsync(repoDir: string): Promise<string | null> {
	return new Promise((resolvePromise) => {
		execFile(
			"git",
			["--no-optional-locks", "symbolic-ref", "--quiet", "--short", "HEAD"],
			{
				cwd: repoDir,
				encoding: "utf8",
			},
			(error: ExecFileException | null, stdout: string) => {
				if (error) {
					resolvePromise(null);
					return;
				}
				const branch = stdout.trim();
				resolvePromise(branch || null);
			},
		);
	});
}

function parseGitDiffNumstat(stdout: string): GitDiffStats {
	const stats = { ...EMPTY_GIT_DIFF_STATS };
	for (const line of stdout.split(/\r?\n/)) {
		if (!line.trim()) continue;
		const [insertions, deletions] = line.split("\t");
		stats.filesChanged++;
		const parsedInsertions = insertions === "-" ? 0 : Number.parseInt(insertions ?? "0", 10);
		const parsedDeletions = deletions === "-" ? 0 : Number.parseInt(deletions ?? "0", 10);
		if (!Number.isNaN(parsedInsertions)) stats.insertions += parsedInsertions;
		if (!Number.isNaN(parsedDeletions)) stats.deletions += parsedDeletions;
	}
	return stats;
}

function parseGitUntrackedFileCount(stdout: string): number {
	let count = 0;
	for (const line of stdout.split(/\r?\n/)) {
		if (line.startsWith("?? ")) {
			count++;
		}
	}
	return count;
}

function addUntrackedFileCount(stats: GitDiffStats, untrackedFiles: number): GitDiffStats {
	return {
		filesChanged: stats.filesChanged + untrackedFiles,
		insertions: stats.insertions,
		deletions: stats.deletions,
	};
}

function resolveGitUntrackedFileCountWithGitSync(repoDir: string): number | null {
	const result = spawnSync(
		"git",
		["--no-optional-locks", "status", "--porcelain=v1", "--untracked-files=normal", "--"],
		{
			cwd: repoDir,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		},
	);
	return result.status === 0 ? parseGitUntrackedFileCount(result.stdout) : null;
}

function resolveGitDiffStatsWithGitSync(repoDir: string): GitDiffStats | null {
	const result = spawnSync("git", ["--no-optional-locks", "diff", "--numstat", "HEAD", "--"], {
		cwd: repoDir,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
	});
	if (result.status !== 0) return null;
	const stats = parseGitDiffNumstat(result.stdout);
	const untrackedFiles = resolveGitUntrackedFileCountWithGitSync(repoDir);
	return untrackedFiles === null ? stats : addUntrackedFileCount(stats, untrackedFiles);
}

function resolveGitDiffStatsWithGitAsync(repoDir: string): Promise<GitDiffStats | null> {
	const diffStats = new Promise<GitDiffStats | null>((resolvePromise) => {
		execFile(
			"git",
			["--no-optional-locks", "diff", "--numstat", "HEAD", "--"],
			{
				cwd: repoDir,
				encoding: "utf8",
			},
			(error: ExecFileException | null, stdout: string) => {
				if (error) {
					resolvePromise(null);
					return;
				}
				resolvePromise(parseGitDiffNumstat(stdout));
			},
		);
	});
	const untrackedFiles = new Promise<number | null>((resolvePromise) => {
		execFile(
			"git",
			["--no-optional-locks", "status", "--porcelain=v1", "--untracked-files=normal", "--"],
			{
				cwd: repoDir,
				encoding: "utf8",
			},
			(error: ExecFileException | null, stdout: string) => {
				if (error) {
					resolvePromise(null);
					return;
				}
				resolvePromise(parseGitUntrackedFileCount(stdout));
			},
		);
	});
	return Promise.all([diffStats, untrackedFiles]).then(([stats, count]) => {
		if (!stats) return null;
		return count === null ? stats : addUntrackedFileCount(stats, count);
	});
}

function gitDiffStatsEqual(a: GitDiffStats | null | undefined, b: GitDiffStats | null): boolean {
	return a?.filesChanged === b?.filesChanged && a?.insertions === b?.insertions && a?.deletions === b?.deletions;
}

function isWslEnvironment(): boolean {
	return process.platform === "linux" && !!(process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP);
}

function isWindowsMountedRepoPath(repoDir: string): boolean {
	return /^\/mnt\/[a-z](?:\/|$)/i.test(repoDir);
}

function shouldPollGitHead(repoDir: string): boolean {
	return isWslEnvironment() && isWindowsMountedRepoPath(repoDir);
}

/**
 * Provides git branch and extension statuses - data not otherwise accessible to extensions.
 * Context usage on ctx.getContextUsage(), model info on ctx.model.
 */
export class FooterDataProvider {
	private cwd: string;
	private static readonly WATCH_DEBOUNCE_MS = 500;

	private extensionStatuses = new Map<string, string>();
	private cachedBranch: string | null | undefined = undefined;
	private cachedDiffStats: GitDiffStats | null | undefined = undefined;
	private gitPaths: GitPaths | null | undefined = undefined;
	private headWatcher: FSWatcher | null = null;
	private headWatchFilePath: string | null = null;
	private headWatchFileListener: ((current: Stats, previous: Stats) => void) | null = null;
	private reftableWatcher: FSWatcher | null = null;
	private reftableTablesListWatcher: FSWatcher | null = null;
	private reftableTablesListPath: string | null = null;
	private branchChangeCallbacks = new Set<() => void>();
	private availableProviderCount = 0;
	private refreshTimer: ReturnType<typeof setTimeout> | null = null;
	private gitWatcherRetryTimer: ReturnType<typeof setTimeout> | null = null;
	private refreshInFlight = false;
	private refreshPending = false;
	private diffStatsRefreshTimer: ReturnType<typeof setTimeout> | null = null;
	private diffStatsRefreshInFlight = false;
	private diffStatsRefreshPending = false;
	private disposed = false;

	constructor(cwd: string) {
		this.cwd = cwd;
		this.gitPaths = findGitPaths(cwd);
		this.setupGitWatcher();
	}

	/** Current git branch, null if not in repo, "detached" if detached HEAD */
	getGitBranch(): string | null {
		if (this.cachedBranch === undefined) {
			this.cachedBranch = this.resolveGitBranchSync();
		}
		return this.cachedBranch;
	}

	/** Current working-tree diff stats, null if not in a repo or if git is unavailable. */
	getGitDiffStats(): GitDiffStats | null {
		if (this.cachedDiffStats === undefined) {
			this.cachedDiffStats = this.resolveGitDiffStatsSync();
			return this.cachedDiffStats;
		}

		this.scheduleDiffStatsRefresh();
		return this.cachedDiffStats;
	}

	/** Extension status texts set via ctx.ui.setStatus() */
	getExtensionStatuses(): ReadonlyMap<string, string> {
		return this.extensionStatuses;
	}

	/** Subscribe to git branch changes. Returns unsubscribe function. */
	onBranchChange(callback: () => void): () => void {
		this.branchChangeCallbacks.add(callback);
		return () => this.branchChangeCallbacks.delete(callback);
	}

	/** Internal: set extension status */
	setExtensionStatus(key: string, text: string | undefined): void {
		if (text === undefined) {
			this.extensionStatuses.delete(key);
		} else {
			this.extensionStatuses.set(key, text);
		}
	}

	/** Internal: clear extension statuses */
	clearExtensionStatuses(): void {
		this.extensionStatuses.clear();
	}

	/** Number of unique providers with available models (for footer display) */
	getAvailableProviderCount(): number {
		return this.availableProviderCount;
	}

	/** Internal: update available provider count */
	setAvailableProviderCount(count: number): void {
		this.availableProviderCount = count;
	}

	setCwd(cwd: string): void {
		if (this.cwd === cwd) {
			return;
		}

		this.cwd = cwd;
		if (this.refreshTimer) {
			clearTimeout(this.refreshTimer);
			this.refreshTimer = null;
		}
		if (this.diffStatsRefreshTimer) {
			clearTimeout(this.diffStatsRefreshTimer);
			this.diffStatsRefreshTimer = null;
		}
		this.clearGitWatchers();
		this.cachedBranch = undefined;
		this.cachedDiffStats = undefined;
		this.gitPaths = findGitPaths(cwd);
		this.setupGitWatcher();
		this.notifyBranchChange();
	}

	/** Internal: cleanup */
	dispose(): void {
		this.disposed = true;
		if (this.refreshTimer) {
			clearTimeout(this.refreshTimer);
			this.refreshTimer = null;
		}
		if (this.diffStatsRefreshTimer) {
			clearTimeout(this.diffStatsRefreshTimer);
			this.diffStatsRefreshTimer = null;
		}
		this.clearGitWatchers();
		this.branchChangeCallbacks.clear();
	}

	private notifyBranchChange(): void {
		for (const cb of this.branchChangeCallbacks) cb();
	}

	private scheduleRefresh(): void {
		if (this.disposed || this.refreshTimer) return;
		if (this.refreshInFlight) {
			this.refreshPending = true;
			return;
		}
		this.refreshTimer = setTimeout(() => {
			this.refreshTimer = null;
			void this.refreshGitBranchAsync();
		}, FooterDataProvider.WATCH_DEBOUNCE_MS);
	}

	private scheduleDiffStatsRefresh(): void {
		if (this.disposed || this.diffStatsRefreshTimer) return;
		if (this.diffStatsRefreshInFlight) {
			this.diffStatsRefreshPending = true;
			return;
		}
		this.diffStatsRefreshTimer = setTimeout(() => {
			this.diffStatsRefreshTimer = null;
			void this.refreshGitDiffStatsAsync();
		}, FooterDataProvider.WATCH_DEBOUNCE_MS);
	}

	private async refreshGitBranchAsync(): Promise<void> {
		if (this.disposed) return;
		if (this.refreshInFlight) {
			this.refreshPending = true;
			return;
		}

		this.refreshInFlight = true;
		try {
			const nextBranch = await this.resolveGitBranchAsync();
			if (this.disposed) return;
			if (this.cachedBranch !== undefined && this.cachedBranch !== nextBranch) {
				this.cachedBranch = nextBranch;
				this.cachedDiffStats = undefined;
				this.notifyBranchChange();
				return;
			}
			this.cachedBranch = nextBranch;
		} finally {
			this.refreshInFlight = false;
			if (this.refreshPending && !this.disposed) {
				this.refreshPending = false;
				this.scheduleRefresh();
			}
		}
	}

	private resolveGitBranchSync(): string | null {
		try {
			if (!this.gitPaths) return null;
			const content = readFileSync(this.gitPaths.headPath, "utf8").trim();
			if (content.startsWith("ref: refs/heads/")) {
				const branch = content.slice(16);
				return branch === ".invalid" ? (resolveBranchWithGitSync(this.gitPaths.repoDir) ?? "detached") : branch;
			}
			return "detached";
		} catch {
			return null;
		}
	}

	private resolveGitDiffStatsSync(): GitDiffStats | null {
		try {
			if (!this.gitPaths) return null;
			return resolveGitDiffStatsWithGitSync(this.gitPaths.repoDir);
		} catch {
			return null;
		}
	}

	private async resolveGitBranchAsync(): Promise<string | null> {
		try {
			if (!this.gitPaths) return null;
			const content = readFileSync(this.gitPaths.headPath, "utf8").trim();
			if (content.startsWith("ref: refs/heads/")) {
				const branch = content.slice(16);
				return branch === ".invalid"
					? ((await resolveBranchWithGitAsync(this.gitPaths.repoDir)) ?? "detached")
					: branch;
			}
			return "detached";
		} catch {
			return null;
		}
	}

	private async refreshGitDiffStatsAsync(): Promise<void> {
		if (this.disposed) return;
		if (this.diffStatsRefreshInFlight) {
			this.diffStatsRefreshPending = true;
			return;
		}

		this.diffStatsRefreshInFlight = true;
		try {
			const nextStats = await this.resolveGitDiffStatsAsync();
			if (this.disposed) return;
			if (!gitDiffStatsEqual(this.cachedDiffStats, nextStats)) {
				this.cachedDiffStats = nextStats;
				this.notifyBranchChange();
				return;
			}
			this.cachedDiffStats = nextStats;
		} finally {
			this.diffStatsRefreshInFlight = false;
			if (this.diffStatsRefreshPending && !this.disposed) {
				this.diffStatsRefreshPending = false;
				this.scheduleDiffStatsRefresh();
			}
		}
	}

	private async resolveGitDiffStatsAsync(): Promise<GitDiffStats | null> {
		try {
			if (!this.gitPaths) return null;
			return await resolveGitDiffStatsWithGitAsync(this.gitPaths.repoDir);
		} catch {
			return null;
		}
	}

	private clearGitWatchers(): void {
		closeWatcher(this.headWatcher);
		this.headWatcher = null;
		if (this.headWatchFilePath && this.headWatchFileListener) {
			unwatchFile(this.headWatchFilePath, this.headWatchFileListener);
			this.headWatchFilePath = null;
			this.headWatchFileListener = null;
		}
		closeWatcher(this.reftableWatcher);
		this.reftableWatcher = null;
		closeWatcher(this.reftableTablesListWatcher);
		this.reftableTablesListWatcher = null;
		if (this.reftableTablesListPath) {
			unwatchFile(this.reftableTablesListPath);
			this.reftableTablesListPath = null;
		}
		if (this.gitWatcherRetryTimer) {
			clearTimeout(this.gitWatcherRetryTimer);
			this.gitWatcherRetryTimer = null;
		}
	}

	private scheduleGitWatcherRetry(): void {
		if (this.disposed || this.gitWatcherRetryTimer) {
			return;
		}

		this.gitWatcherRetryTimer = setTimeout(() => {
			this.gitWatcherRetryTimer = null;
			this.setupGitWatcher();
		}, FS_WATCH_RETRY_DELAY_MS);
	}

	private handleGitWatcherError(): void {
		this.clearGitWatchers();
		this.scheduleGitWatcherRetry();
	}

	private setupGitWatcher(): void {
		this.clearGitWatchers();
		if (!this.gitPaths) return;

		const pollGitHead = shouldPollGitHead(this.gitPaths.repoDir);

		// Watch the directory containing HEAD, not HEAD itself.
		// Git uses atomic writes (write temp, rename over HEAD), which changes the inode.
		// fs.watch on a file stops working after the inode changes.
		this.headWatcher = watchWithErrorHandler(
			dirname(this.gitPaths.headPath),
			(_eventType, filename) => {
				if (!filename || filename === "HEAD") {
					this.scheduleRefresh();
				}
			},
			() => this.handleGitWatcherError(),
		);
		if (pollGitHead) {
			this.headWatchFilePath = this.gitPaths.headPath;
			this.headWatchFileListener = (current, previous) => {
				if (
					current.mtimeMs !== previous.mtimeMs ||
					current.ctimeMs !== previous.ctimeMs ||
					current.size !== previous.size
				) {
					this.scheduleRefresh();
				}
			};
			watchFile(this.headWatchFilePath, { interval: 1000 }, this.headWatchFileListener);
		}
		if (!this.headWatcher && !pollGitHead) {
			return;
		}

		// In reftable repos, branch switches update files in the reftable directory
		// instead of HEAD. Watch it separately so the footer picks up those changes.
		const reftableDir = join(this.gitPaths.commonGitDir, "reftable");
		if (existsSync(reftableDir)) {
			this.reftableWatcher = watchWithErrorHandler(
				reftableDir,
				() => {
					this.scheduleRefresh();
				},
				() => this.handleGitWatcherError(),
			);
			if (!this.reftableWatcher) {
				return;
			}

			const tablesListPath = join(reftableDir, "tables.list");
			if (existsSync(tablesListPath)) {
				this.reftableTablesListPath = tablesListPath;
				this.reftableTablesListWatcher = watchWithErrorHandler(
					tablesListPath,
					() => {
						this.scheduleRefresh();
					},
					() => this.handleGitWatcherError(),
				);
				if (!this.reftableTablesListWatcher) {
					return;
				}
				watchFile(tablesListPath, { interval: 250 }, (current, previous) => {
					if (
						current.mtimeMs !== previous.mtimeMs ||
						current.ctimeMs !== previous.ctimeMs ||
						current.size !== previous.size
					) {
						this.scheduleRefresh();
					}
				});
			}
		}
	}
}

/** Read-only view for extensions - excludes setExtensionStatus, setAvailableProviderCount and dispose */
export type ReadonlyFooterDataProvider = Pick<
	FooterDataProvider,
	"getGitBranch" | "getGitDiffStats" | "getExtensionStatuses" | "getAvailableProviderCount" | "onBranchChange"
>;
