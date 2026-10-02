# Native CodeGraph

Pi can maintain a project-local CodeGraph index and expose indexed symbols and static relationships through one native `codebase` tool. It uses the pinned `@colbymchenry/codegraph` library in a Pi-owned Node child process; it does not require a CodeGraph MCP server or a separately managed daemon. The integration is verified on Node 22.23.2. Native indexing is unavailable under Bun, including compiled standalone binaries; existing non-CodeGraph CLI behavior is separate.

## Consent and scope

Indexing applies only to the effective session working directory. Pi does not promote that directory to a parent Git root. CLI startup requires an exact positive persisted project-trust entry for that canonical directory. Generic default trust, trust inherited from a parent, and resource-loading eligibility alone do not authorize indexing. SDK callers must pass an explicit root-scoped grant:

```ts
const { session } = await createAgentSession({
  cwd: projectDirectory,
  codegraph: { root: projectDirectory },
});
```

An interactive `/codegraph refresh` may ask for consent for the displayed exact root. Headless callers receive an authorization-required result instead. This grant does not change Pi's general project-trust policy.

The setting defaults to enabled after authorization. Set it to `false` to opt out:

```json
{
  "codegraph": {
    "enabled": false,
    "watch": true,
    "debounceMs": 250,
    "exclude": ["generated/**"]
  }
}
```

`watch` controls incremental file watching; `debounceMs` defaults to 250 and accepts 100–5,000; `exclude` adds project-relative exclusions and must be an array of strings. Malformed exclusion configuration is rejected rather than silently dropped. Project settings are subject to Pi's existing project-settings trust rules. Sessions sharing a root must use equivalent effective settings. A conflicting lease fails closed until all existing owners release the root; Pi does not silently reuse a less restrictive index. Reload releases the session's previous lease and acquires current settings. Previously applied exclusions remain enforced in `codegraph.json`; removing a setting does not automatically reinclude private source.

Graph data belongs in `<authorized-project>/.codegraph/`; it must not be moved to a shared home-directory cache. On Unix, storage must be owner-private: directory mode `0700`, files `0600` or stricter. The child uses a private umask without changing the host's umask. Existing group/world-accessible storage is rejected; review ownership and permissions before reopening it. Home directories and filesystem roots are ineligible. Check project-local ignore behavior before adopting the feature in a repository where generated state must never appear in version control.

## Commands and tool

`/codegraph` and `/codegraph status` report on-demand state. `/codegraph refresh` requests an incremental refresh. These commands do not start an agent turn, require provider authentication, add conversation context, or depend on extensions. In print text mode they write only the requested result; JSON and RPC emit a framed `codegraph_result` event. Background indexing is quiet: Pi adds no footer, spinner, status item, notification, or automatic context.

The `codebase` tool provides `search`, `symbols`, `callers`, `callees`, `dependencies`, `impact`, and `context`. Its search is lexical retrieval over indexed symbol metadata plus graph context. It is not embedding-based semantic search and does not replace `grep` for exact strings, arbitrary source text, generated or unindexed files, or unsupported languages. Static relationships can be incomplete or heuristic, especially for indirect/runtime behavior. Treat scores as relative rankings and read source before editing.

Results carry project-relative paths, identifiers and line ranges where available, revision/freshness/partial state, and explicit limits or failure status. Caller/callee results include the indexed query `subject` separately from the limited neighbor list. Dependencies include the indexed file `subject` and effective `imports` or `dependents` direction; the default is `imports`. Unindexed or excluded files return `not_found`, not an echoed origin. Traversal depth `0` returns no neighbors while retaining a resolved caller/callee subject. Responses are valid JSON text and are bounded to at most 8,000 UTF-8 bytes; requested budgets below 1,024 bytes are rejected. Truncation omits complete records rather than cutting paths or identifiers. Smaller budgets can be requested within that range.

## Data limits

The index is a navigation aid, not an always-fresh source of truth. Initial indexing and refresh can leave it starting, stale, partial, or degraded; inspect `/codegraph status`. Use `read`, `grep`, `find`, and `bash` as fallbacks, and verify indexed results against current source. The frozen TypeScript fixture verifies relative `.ts` and `.js` import specifiers resolving to its existing `.ts` files. This does not establish complete TypeScript module resolution, including path aliases, package exports, or every ambiguous import.

The graph is project-local. Do not place secrets in source files that are otherwise allowed for indexing. The exclusion policy excludes `.env` and `.env.*`, private-key extensions (`.pem`, `.key`, `.p12`, `.pfx`), `id_rsa*`, `id_ed25519*`, `.ssh/`, `.aws/`, `auth.json`, `.npmrc`, and `.netrc`, including nested paths. It also excludes graph storage, dependencies, and common build outputs. Pi narrowly merges these exclusions into the authorized root's `codegraph.json`, preserving other fields and existing exclusions. Additional settings use project-relative gitignore patterns without negation; mandatory exclusions take precedence over user inclusion rules. Malformed or unsafe configuration/storage fails closed.

Source symlinks are excluded before indexing. Symlink names containing gitignore metacharacters, backslashes, or control characters cause a fail-closed error rather than risking an ineffective exclusion. Snippet reads reject symlinks and read at most 1 MiB from a permitted source file; returned snippets remain subject to the smaller output limits.

This policy cannot detect arbitrary secrets embedded in ordinary source. Add project-specific exclusions for sensitive files. To roll back configuration additions, stop all root owners and review `.codegraph/pi-policy.json` against current `codegraph.json`; remove only patterns you confirm are unwanted Pi additions. Never blindly remove a matching pattern adopted by the project owner. No user-level configuration or shared service is changed by repository integration.
