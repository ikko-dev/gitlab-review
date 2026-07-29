# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.9.4] - 2026-07-29

### Added

- Claude plugin marketplaces as a skill source: declare one with `CODE_REVIEW_MARKETPLACES` / `--marketplace` (`<name>=<[format:]url[#ref]>`), then reference skills by logical `<marketplace>:<plugin>/<skill>` name — resolved via the repo's `.claude-plugin/marketplace.json` instead of a hand-written in-repo path. Defaults to the `anthropic` manifest format; credentials are redacted from logs/errors ([#142]).

## [0.9.3] - 2026-07-23

### Fixed

- `server.address` is now populated for GitHub reviews (was empty): the diagnostics context uses the platform-appropriate server URL — the GitHub server URL on GitHub, the GitLab instance URL on GitLab — so the telemetry host label is correct on both platforms ([#141]).

### Added

- The reusable workflow (`.github/workflows/code-review.yml`) now forwards the entire `CODE_REVIEW_*` namespace from org/repo variables and inherited secrets, so all configuration — settings, provider credentials, and OpenTelemetry (`CODE_REVIEW_OTEL` + `CODE_REVIEW_OTEL_EXPORTER_OTLP_*`, de-prefixed to `OTEL_*` by the CLI) — is set purely at the org level with no per-repo workflow changes (`secrets: inherit`). Replaces the previous hardcoded subset ([#140]).

## [0.9.2] - 2026-07-22

### Fixed

- Reverted the 0.9.1 delta-temporality default: Grafana Cloud's OTLP endpoint silently dropped every delta-temporality metric (a review's metrics never ingested), so metrics return to cumulative temporality. Aggregate range totals from these short-lived-job cumulative metrics with per-series `max_over_time(..._sum[range])` (see [docs/observability.md](docs/observability.md)) ([#139]).

## [0.9.1] - 2026-07-22

### Fixed

- Metrics now default to **delta** temporality (`OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE`), so cost/token totals aggregate correctly from short-lived CI review jobs. Cumulative temporality made each ephemeral job's series start mid-flight in the backend, so range queries over-counted (`sum_over_time`) or under-counted (`increase`); the emitted values were always correct (verified against the provider gateway) — only their range aggregation was wrong. Override with `…TEMPORALITY_PREFERENCE=cumulative` for long-running hosts ([#138]).

## [0.9.0] - 2026-07-22

### Changed

- **Breaking (telemetry):** renamed all OTel/diagnostics identifiers to platform-neutral names (`code_review_*`, `code_review.*`, `vcs.*`, `cicd.*`) and aligned the GenAI signals with current OTel semconv (`gen_ai.provider.name`, `gen_ai.client.operation.time_to_first_chunk`, cost off the `gen_ai.*` namespace). Dashboards and queries must be updated — mapping in [docs/observability.md](docs/observability.md) ([#137]).

### Added

- `code_review.dry_run` label on the per-turn `gen_ai.client.*` metrics ([#137]).
- Telemetry `vcs.*`/`cicd.*` CI attributes are now sourced from GitHub Actions env vars too (not just GitLab CI), so they populate on GitHub PR reviews ([#137]).
- `vcs.provider.name` (`gitlab`/`github`) and `server.address` (instance host) labels on every signal, so dashboards can filter by platform and by instance (e.g. multiple GitLab servers); plus the canonical `vcs.repository.url.full` on spans/logs ([#137]).
- `code_review.first_review` label on the review-level metrics — true when the MR/PR has no prior bot review — so distinct MRs/PRs (and cost per MR/PR) can be counted from metrics without a high-cardinality change-id label ([#137]).

### Fixed

- Review-level cost/token metrics now capture the partial spend of runs that fail mid-flight instead of dropping it to zero ([#137]).

## [0.8.6] - 2026-07-21

### Fixed

- A configured skill that fails to load (e.g. an external `git:` skill that can't be downloaded) now warns and is skipped instead of aborting the whole review ([#134]).
- GitHub: a fixed finding whose review thread went outdated (but was never manually resolved) is no longer re-listed under "Still open from earlier reviews" — outdated threads are now treated as settled, mirroring GitLab's auto-resolve-outdated behaviour ([#135]).

## [0.8.5] - 2026-07-20

### Added

- `--input-mode` / `CODE_REVIEW_INPUT_MODE` with a new default `auto`: the reviewer receives the diff inline while it fits the char budget and switches to on-disk staging once it overflows (the agent reads files on demand), which raised recall on large over-budget diffs in evals where inline's retrieval fallback went under-used. Explicit `inline`, `disk`, and `commits` modes are also selectable, and read-only git tools (`git_log`/`git_show`/`git_diff`) are available to the reviewer in every mode when run against a checkout ([#131]).

### Changed

- On diffs that overflow the char budget, the default (`auto`) now stages the whole change on disk for the reviewer to read on demand, instead of reviewing the fitted diff inline with on-disk retrieval of only the dropped files. The previous inline-plus-retrieval behaviour is unchanged but now opt-in via `--input-mode inline` ([#131]).

## [0.8.4] - 2026-07-16

### Changed

- On-disk retrieval of size-dropped diffs is now on by default (was the opt-in `--retrieve-skipped`); disable with `--no-retrieve-skipped` / `CODE_REVIEW_RETRIEVE_SKIPPED=0`. The size-skip summary callout now frames dropped files as staged-for-retrieval and no longer has the reviewer re-list them in its prose ([#129]).

### Added

- Moving `MAJOR` and `MAJOR.MINOR` tags (e.g. `0` and `0.8`), re-pointed to each stable release, so action consumers can pin `@0` (latest stable) or `@0.8` (non-breaking patches) instead of a full version. While in 0.x, `@0` may cross breaking changes since a minor bump signals one; it becomes a true compatibility boundary at 1.0 ([#127], [#128]).

## [0.8.3] - 2026-07-16

### Changed

- Docs reframed for dual GitLab + GitHub support: platform auto-detection, GitHub environment/flags, both output transports, and the composite-action vs reusable-workflow `secrets: inherit` caveat ([#124]).

### Fixed

- GitHub: resolved review threads are now recognized, so the summary no longer re-lists findings that were already addressed. Thread resolution is read from the GraphQL `reviewThreads` API (GitHub's REST comment endpoints omit it), fixing both summary carry-over and prior-thread context ([#125]).

## [0.8.2] - 2026-07-15

### Added

- A reusable workflow (`.github/workflows/code-review.yml`, `on: workflow_call`) for one-line setup — callers use `uses: weareikko/code-review/.github/workflows/code-review.yml@<ref>` plus `secrets: inherit`, with review settings read from `CODE_REVIEW_*` variables ([#123]).

### Changed

- The composite action now checks out the repository by default (new `checkout` input, default `true`, plus a `fetch-depth` input); bundled `actions/checkout`/`actions/setup-node` bumped to v5 ([#123]).

## [0.8.1] - 2026-07-15

### Changed

- The default review-output artifact filename is now `code-review.md` (was `gitlab-review.md`), aligning it with the tool's identity. Override with `--review-file` (or the `reviewFile` option) to keep the previous name.

## [0.8.0] - 2026-07-15

### Added

- Review GitHub pull requests with the same engine as GitLab MRs: the platform is auto-detected from the environment (`--platform github|gitlab` to force it), findings post as one batched PR review with an upserted summary comment. Ships a composite `action.yml` and a GitHub Actions setup guide in the README ([#118]).

### Changed

- Diagnostics phase/channel names renamed `gitlab.* → scm.*` (`get_merge_request`, `get_latest_version`, `get_discussions`, `post_comments`, `upsert_summary`) ([#118]).
- `GeneratedComment.payload` is now generic (platform-specific payload; GitLab keeps `GitLabDiscussionPayload`) ([#118]).
- **BREAKING**: renamed the product identity from `gitlab-review` to `code-review` to reflect dual-platform support — the npm package (`@weareikko/code-review`), the CLI command (`code-review`, run via `bin/code-review.js`), the review footer name, the `diagnostics_channel`/OpenTelemetry name prefix (`@weareikko/code-review:*`), and the hidden dedup/summary/fingerprint marker prefixes (`code-review:`) all change; readers stay backward-compatible (summary notes and fingerprints posted under the old identity are still matched and deduplicated, so the first post-upgrade run upserts rather than duplicating); the GitHub repository moved `ikko-dev/gitlab-review → weareikko/code-review` (org `ikko-dev → weareikko` and repository name `gitlab-review → code-review`), and the reviewed-commit footer reader still matches footers written under the former org and repository/product name ([#121]).
- **BREAKING**: renamed the product-scoped environment-variable prefix `GITLAB_REVIEW_* → CODE_REVIEW_*` (e.g. `GITLAB_REVIEW_MODEL → CODE_REVIEW_MODEL`, and the namespacing shim that de-prefixes provider/infra vars in shared CI) with no backward compatibility — the old names are no longer read, so existing CI configs must rename their variables. Unprefixed GitLab tokens (`GITLAB_TOKEN`, `CI_JOB_TOKEN`, …) are unchanged ([#121]).

[Unreleased]: https://github.com/weareikko/code-review/compare/0.9.4...HEAD
[0.9.4]: https://github.com/weareikko/code-review/compare/0.9.3...0.9.4
[0.9.3]: https://github.com/weareikko/code-review/compare/0.9.2...0.9.3
[0.9.2]: https://github.com/weareikko/code-review/compare/0.9.1...0.9.2
[0.9.1]: https://github.com/weareikko/code-review/compare/0.9.0...0.9.1
[0.9.0]: https://github.com/weareikko/code-review/compare/0.8.6...0.9.0
[0.8.6]: https://github.com/weareikko/code-review/compare/0.8.5...0.8.6
[0.8.5]: https://github.com/weareikko/code-review/compare/0.8.4...0.8.5
[0.8.4]: https://github.com/weareikko/code-review/compare/0.8.3...0.8.4
[#142]: https://github.com/weareikko/code-review/pull/142
[#141]: https://github.com/weareikko/code-review/pull/141
[#140]: https://github.com/weareikko/code-review/pull/140
[#137]: https://github.com/weareikko/code-review/pull/137
[#135]: https://github.com/weareikko/code-review/pull/135
[#134]: https://github.com/weareikko/code-review/pull/134
[#131]: https://github.com/weareikko/code-review/pull/131
[#129]: https://github.com/weareikko/code-review/pull/129
[#128]: https://github.com/weareikko/code-review/pull/128
[#127]: https://github.com/weareikko/code-review/pull/127
[0.8.3]: https://github.com/weareikko/code-review/compare/0.8.2...0.8.3
[#125]: https://github.com/weareikko/code-review/pull/125
[#124]: https://github.com/weareikko/code-review/pull/124
[0.8.2]: https://github.com/weareikko/code-review/compare/0.8.1...0.8.2
[#123]: https://github.com/weareikko/code-review/pull/123
[0.8.1]: https://github.com/weareikko/code-review/compare/0.8.0...0.8.1
[0.8.0]: https://github.com/weareikko/code-review/compare/0.7.6...0.8.0
[#118]: https://github.com/weareikko/code-review/pull/118
[#121]: https://github.com/weareikko/code-review/pull/121

## [0.7.6] - 2026-07-09

### Added

- The `Review usage:` footer now records the `--thinking` level (`thinking: <level>`, including the `off` default) alongside the model and cost, so the summary note captures the reasoning effort the run used ([#111]).

[0.7.6]: https://github.com/weareikko/code-review/compare/0.7.5...0.7.6
[#111]: https://github.com/weareikko/code-review/pull/111

## [0.7.5] - 2026-07-08

### Changed

- Noise filtering is now layered (path + diff content) instead of a flat path list: a cross-ecosystem lockfile set matched by basename at any depth (adds `composer.lock`, `go.sum`, `Cargo.lock`, etc.), generated-dir patterns matched at any depth, and content heuristics that skip minified/compiled blobs and generated-banner files regardless of name — so machine-written churn no longer consumes the diff budget and starves real source of coverage ([#107]).

### Fixed

- The reviewer no longer treats MR description/intent mismatches as first-class inline findings: the `<intent>` block is a lens for reading the diff, unmet/exceeded promises are never CRITICAL or blocking, inline findings must anchor on code (never on README/description prose), and scope-creep is surfaced in one summary line. Keeps the finder focused on demonstrable code defects ([#108]).
- `verify` depth no longer echoes the verifier's dropped/downgraded findings into the summary Notes; a refuted finding is a non-issue the developer never saw, so only the Find model's own context notes remain. Drop/downgrade counts stay in the run log ([#106]).

[0.7.5]: https://github.com/weareikko/code-review/compare/0.7.4...0.7.5
[#106]: https://github.com/weareikko/code-review/pull/106
[#107]: https://github.com/weareikko/code-review/pull/107
[#108]: https://github.com/weareikko/code-review/pull/108

## [0.7.4] - 2026-07-02

### Added

- Report partial-review coverage: when the diff char budget drops files, the reviewer prompt and summary size callout now surface `~N% of changed lines reviewed`, and the budget ranks files by changed-line count before dropping. New `--diff-context` / `GITLAB_REVIEW_DIFF_CONTEXT` tunes hunk context (`git diff --unified`) as a coverage/token lever ([#103]).
- Optional `--retrieve-skipped` / `GITLAB_REVIEW_RETRIEVE_SKIPPED` (default off): stage diffs for files dropped by the size budget on disk so the reviewer can read them on demand instead of losing them ([#104]).

### Changed

- Default prompt-cache retention to `long` (24h) so repeated reviews reuse the cached system-prompt prefix on providers that support it (OpenAI, incl. via the Cloudflare AI Gateway); no-op on Anthropic. Override with `PI_CACHE_RETENTION` / `GITLAB_REVIEW_PI_CACHE_RETENTION` ([#102]).

[0.7.4]: https://github.com/weareikko/code-review/compare/0.7.3...0.7.4
[#102]: https://github.com/weareikko/code-review/pull/102
[#103]: https://github.com/weareikko/code-review/pull/103
[#104]: https://github.com/weareikko/code-review/pull/104

## [0.7.3] - 2026-07-02

### Fixed

- The posted summary usage footer reports all models — the run total is labelled `(N models)` instead of the find model alone, and the per-model breakdown is included (previously only in the job log) ([#98]).
- Curb severity inflation: the guard-exclusion gate is now a hard rule in the base prompt (not just the skill), and a CRITICAL that isn't high-confidence is downgraded to WARN at parse time, so an unproven "blocking" claim can't gate a merge — including in `single` depth ([#99]).
- The summary carries still-open findings across runs: an unresolved prior inline thread the current run doesn't re-emit is retained in the summary and the risk line never drops below it ([#100]).

[0.7.3]: https://github.com/weareikko/code-review/compare/0.7.2...0.7.3
[#98]: https://github.com/weareikko/code-review/pull/98
[#99]: https://github.com/weareikko/code-review/pull/99
[#100]: https://github.com/weareikko/code-review/pull/100

## [0.7.2] - 2026-07-01

### Added

- The built-in `code-review` skill now carries a fixed Fowler code-smell baseline (duplication, feature envy, primitive obsession, data clumps, etc.) as a secondary, non-blocking dimension: repo standards override it, every smell is a judgment call, and smells cap at WARN (never CRITICAL) ([#90]).
- `--verify-model` / `GITLAB_REVIEW_VERIFY_MODEL`: route the Verify stage (`verify`/`full` depth) to its own model, pairing a cheap high-recall finder with a strong high-precision verifier; warns when the verify model looks cheaper than the find model. Opt-in; default keeps the pool-based verifier ([#95]).

### Changed

- Move the diff and commit log into the shared Verify system prompt so the provider caches them once per run instead of re-writing them behind each finding; cuts Verify-stage cost on diff-heavy reviews (~24% at the default concurrency, more when serial). Adds a `GITLAB_REVIEW_VERIFY_CONCURRENCY` knob ([#89]).

### Fixed

- Inline findings no longer re-post when the author edits nearby lines: the duplicate-prevention secondary fingerprint dropped the diff hunk and now keys on file + side + body only, restoring the edit-stable fallback ([#96]).

[0.7.2]: https://github.com/weareikko/code-review/compare/0.7.1...0.7.2
[#89]: https://github.com/weareikko/code-review/pull/89
[#90]: https://github.com/weareikko/code-review/pull/90
[#95]: https://github.com/weareikko/code-review/pull/95
[#96]: https://github.com/weareikko/code-review/pull/96

## [0.7.1] - 2026-06-18

### Fixed

- Fail loudly (`ParseError`, exit 1, with a reason and preview) when the reviewer's JSON output is unparseable, instead of silently posting an empty review. Adds `jsonrepair` recovery of lightly malformed output, anchored unfenced-object extraction, and a hardened JSON-escaping prompt rule; stays non-fatal when usable comments were recovered from the legacy markdown/marker formats ([#86]).

### Changed

- Warn and skip (exit 0) instead of failing the pipeline when the model provider is out of credits/quota (e.g. HTTP 402); transient 429 rate limits still fail ([#87]).
- Split the README into a lean landing page plus dedicated `docs/` reference pages ([#85]).

[0.7.1]: https://github.com/weareikko/code-review/compare/0.7.0...0.7.1
[#85]: https://github.com/weareikko/code-review/pull/85
[#86]: https://github.com/weareikko/code-review/pull/86
[#87]: https://github.com/weareikko/code-review/pull/87

## [0.7.0] - 2026-06-17

### Added

- Heterogeneous `full`-depth review via a model pool (`--model-pool` / `GITLAB_REVIEW_MODEL_POOL`): deterministic per-angle model mapping, a cross-family verifier, per-model usage breakdown, and graceful degradation when a provider key is missing ([#83]).
- Multi-stage review via `--review-depth single|verify|full` (`GITLAB_REVIEW_DEPTH`, default `single`): adversarial Verify and multi-angle Find → Triage → Synthesize. See `docs/multi-stage-review.md` ([#69]).
- Oversized diffs surfaced as a decompose signal — a prominent summary callout of skipped files — with `--max-diff-chars` and `--decompose-hint-lines`, instead of being silently trimmed ([#81]).
- Built-in `test-integrity` skill that flags silent test tampering (weakened/deleted/disabled/blindly-rewritten assertions) ([#82]).
- Optional `GITLAB_REVIEW_` namespace for provider/infra env vars in shared CI ([#79]).
- Reviewer reads the MR title/description as declared intent and flags code/intent mismatches ([#80]).

### Changed

- `full`-depth Triage dedup is now fuzzy and deterministic (proximity + token-set similarity, order-independent, higher severity wins) ([#83]).

[0.7.0]: https://github.com/weareikko/code-review/compare/0.6.2...0.7.0
[#69]: https://github.com/weareikko/code-review/pull/69
[#79]: https://github.com/weareikko/code-review/pull/79
[#80]: https://github.com/weareikko/code-review/pull/80
[#81]: https://github.com/weareikko/code-review/pull/81
[#82]: https://github.com/weareikko/code-review/pull/82
[#83]: https://github.com/weareikko/code-review/pull/83

## [0.6.2] - 2026-06-08

### Added

- GitLab API errors now carry their HTTP status in OpenTelemetry (`error.type=GITLAB_API_ERROR_500`, plus HTTP attributes on the write-phase spans) so a 5xx rate is alertable (`GITLAB_REVIEW_OTEL=1`).

### Fixed

- `draft_notes/bulk_publish` no longer 500s when a comment lands on an unchanged context line: positions are resolved against the diff so context lines carry both `old_line` and `new_line` (read with `core.quotepath=false` for non-ASCII paths) ([gitlab-org/gitlab#579609](https://gitlab.com/gitlab-org/gitlab/-/issues/579609)).
- Draft publishing falls back to per-draft publish when `bulk_publish` fails, so one rejected draft no longer sinks the batch; the count of unpublishable drafts is reported.

[0.6.2]: https://github.com/weareikko/code-review/compare/0.6.1...0.6.2

## [0.6.1] - 2026-06-03

### Added

- Skills can be loaded from a git remote (`git:` / `git+ssh:`), shallow-cloned at a pinned ref and cached, completing external skill distribution; `git+ssh://` is recommended for private remotes.
- Closed OpenTelemetry gaps across metrics, logs, and traces: new run/error/token counters, severity-broken-down comment counts, a `gitlab_review.started` log, and HTTP/diff/tool span attributes (`GITLAB_REVIEW_OTEL=1`).
- `GitLabClient` accepts an optional `onResponse` instrumentation hook (method, path, url, status, content-length); carries no secrets.

### Changed

- Internal refactors with no behaviour change (shared `fetchWithTimeout`, derived `diagnosticChannels`, hoisted parser regexes).
- Internal OTel bridge cleanup with no telemetry change (shared attribute/label helpers).

[0.6.1]: https://github.com/weareikko/code-review/compare/0.6.0...0.6.1

## [0.6.0] - 2026-06-02

### Changed

- The MR summary uses a standardized, scannable layout under `### Code Review`: a `**Risk: Low | Medium | High**` line, a short overview, a `**N issues found:**` list, and an optional `**Notes:**` block.
- Skill `SKILL.md` frontmatter is parsed with a real YAML parser (`yaml`); invalid frontmatter is rejected rather than salvaged.
- The review-completed OTel log's `gen_ai.request.model` uses the full model ID (everything after the first `/`), matching the span/metric attributes.

### Removed

- **BREAKING:** dropped the deprecated `body` field from the exported `Skill` type; read `SKILL.md` from `filePath` instead.
- **BREAKING:** dropped all `pi-reviewer` backward compatibility — only `gitlab-review:*` markers are read/written, so threads/notes from before the rename are no longer deduplicated.
- **BREAKING:** dropped severity emoji (🔴/🟡/🔵) handling from reviewer-output parsing; severity comes from the explicit JSON field.

[0.6.0]: https://github.com/weareikko/code-review/compare/0.5.0...0.6.0

## [0.5.0] - 2026-06-02

### Changed

- Clean reviews emit a short `### Overview` (MR description + positive verdict) instead of the bare "No issues found" sentinel.
- **BREAKING:** AI API key resolution delegates to [`@earendil-works/pi-ai`](https://github.com/earendil-works/pi-ai)'s `getEnvApiKey` — read from the provider's standard env var or ambient Bedrock/Vertex creds, with `--api-key` taking precedence.

### Removed

- **BREAKING:** the implicit default model is removed — `--model` (or `GITLAB_REVIEW_MODEL`) is now required.
- **BREAKING:** `GITLAB_REVIEW_API_KEY` is no longer read for the AI key; use the provider's standard env var or `--api-key`.
- **BREAKING:** the `CLAUDE_API_KEY` fallback is removed; use `ANTHROPIC_API_KEY` / `ANTHROPIC_OAUTH_TOKEN`.

### Fixed

- Parser accepts unfenced JSON reviewer output (a bare top-level object or one appended after prose) instead of resolving to zero comments.

[0.5.0]: https://github.com/weareikko/code-review/compare/0.4.2...0.5.0

## [0.4.2] - 2026-06-01

### Added

- Reviewer findings carry a `confidence` field (`high` | `medium` | `low`) separate from `severity`, with an interaction rule (a CRITICAL finding must be high confidence).
- Confidence is rendered inline in each comment (`_Confidence: <level>._`) and excluded from the fingerprint hash.

### Changed

- The reviewer JSON schema requires `confidence` on every comment; older output without it parses as `high`.
- Severity rubric anchored to impact + certainty (use the lowest fitting tier; demonstrate the failing path for CRITICAL).
- Context-suppressed findings must be echoed in the summary Notes section so suppression is auditable.
- Strengthened the skill-Read instruction (skills are mandatory rule sets; includes a worked `Read(...)` example).

[0.4.2]: https://github.com/weareikko/code-review/compare/0.4.1...0.4.2

## [0.4.1] - 2026-05-29

### Changed

- Bot comment titles are bolded so the Conventional Comment header stands out.
- Commit footer includes the package version (`Reviewed by … v<VERSION> for commit <sha>.`); SHA extraction stays backwards-compatible with versionless footers.

[0.4.1]: https://github.com/weareikko/code-review/compare/0.4.0...0.4.1

## [0.4.0] - 2026-05-28

### Changed

- Reviewer output adopts [Conventional Comments](https://conventionalcomments.org/) format (`<label> [decoration]: <subject>` + discussion), with an enforced severity↔label mapping (CRITICAL → `issue (blocking)`, WARN → `issue`, INFO → `nitpick`/`suggestion`/…).
- Summary follows a fixed `### Overview` / `### Findings` / `### Notes` skeleton; Findings restates only each subject (anti-duplication).
- Severity emoji dropped from prompt and output; the `severity` JSON field is the source of truth.
- Stricter prompt rules (declarative tone, anti-duplication) with a worked example.

### Added

- Prior developer replies passed to the reviewer as a `<prior_review_feedback>` section so it avoids re-raising acknowledged concerns.
- Commit messages passed as a `<commits>` context section.
- The `code-review` skill treats explicit commit artefacts (ADR/incident refs, sign-offs) as authoritative justification.
- Format-conformance eval scenarios (`ConventionalCommentFormatJudge`, `SummarySkeletonJudge`, `NoDuplicationJudge`).
- `README.md` `## Review output format` section.

[0.4.0]: https://github.com/weareikko/code-review/compare/0.3.12...0.4.0

## [0.3.12] - 2026-05-26

### Added

- `loadAutoDiscoveredSkills` warns (via a `warn` callback wired to `logger.warn`) when a discovered `SKILL.md` is missing required frontmatter, instead of silently dropping it.

[0.3.12]: https://github.com/weareikko/code-review/compare/0.3.11...0.3.12

## [0.3.11] - 2026-05-26

### Added

- Inline review comments end with a `<sub>` commit footer (`Reviewed by … for commit <sha>.`); fingerprints stay computed from the original output so the SHA does not affect dedup.

[0.3.11]: https://github.com/weareikko/code-review/compare/0.3.10...0.3.11

## [0.3.10] - 2026-05-25

### Changed

- Lazy skill body loading ([#42](https://github.com/weareikko/code-review/issues/42)): the prompt emits a `<skill_file>` path reference and the agent reads each `SKILL.md` on demand, avoiding prompt bloat. Adds `Skill.filePath`.

### Added

- `npm:` and `file:` skill spec protocols ([#38](https://github.com/weareikko/code-review/issues/38)), with `parseSkillSpec`, `resolveNpmSkillDir`, and `loadNamedSkill` exports; unresolvable specs throw `ConfigError`. `git:` / `git+ssh:` are parsed but not yet executed.
- Multi-provider LLM support ([#36](https://github.com/weareikko/code-review/issues/36)): `--model` accepts any `@earendil-works/pi-ai` provider (OpenRouter, Gemini, Groq, Mistral, Bedrock, Vertex, …); `provider/modelId` splits on the first `/` only.
- Built-in Ollama support (`--model ollama/<model>`, no API key, configurable `OLLAMA_HOST`).
- Provider-specific API key auto-resolution from the provider's env var; ambient Bedrock/Vertex creds detected, with a setup hint when missing.
- `--base-url` / `GITLAB_REVIEW_BASE_URL` and `--max-tokens` / `GITLAB_REVIEW_MAX_TOKENS`, plus a `parseModelProvider` export.

[0.3.10]: https://github.com/weareikko/code-review/compare/0.3.9...0.3.10

## [0.3.9] - 2026-05-22

### Added

- `GITLAB_REVIEW_OTEL_CAPTURE_CONTENT=1` opt-in: attaches per-turn assistant output and tool args/results to spans (truncated at 2 000 chars), off by default. Adds `isContentCaptureEnabled()`.

### Fixed

- `gen_ai.usage.input_tokens` reports total input (non-cached + cached) on turn/phase spans and the completed log, matching Sentry's convention; adds the `.cached` subset attribute.

[0.3.9]: https://github.com/weareikko/code-review/compare/0.3.8...0.3.9

## [0.3.8] - 2026-05-21

### Fixed

- OTel metric correctness (`GITLAB_REVIEW_OTEL=1`): `gen_ai.client.cost` and token usage are emitted exclusively per-turn (no double-count), cache_read/cache_creation token series are added, and `gen_ai.system` is set consistently (falling back to the configured model for bare model IDs).
- Further OTel fixes: correct the model-string provider split (`indexOf('/')`), correlate log records to traces, split cost by token type, rename `cache_write_usd` → `cache_creation_usd`, drop `gen_ai.response.model` from metric labels, fix the cost histogram unit to `{usd}`, guard zero-value comment increments, and add `gitlab.ci_job_id` / `gitlab.ci_pipeline_id` to spans and logs.

[0.3.8]: https://github.com/weareikko/code-review/compare/0.3.7...0.3.8

## [0.3.7] - 2026-05-21

### Fixed

- Closed OTel metric/log label gaps (`GITLAB_REVIEW_OTEL=1`): `service.name` on every data point, `gen_ai.system` replacing `gen_ai.provider.name` on spans/metrics (and added to per-turn observations), `gen_ai.agent.name` on turn spans, and the warnings/drafts span attributes.

[0.3.7]: https://github.com/weareikko/code-review/compare/0.3.6...0.3.7

## [0.3.6] - 2026-05-21

### Added

- `gen_ai.conversation.id` (the run UUID) on every OTel span, enabling the Sentry Conversations view.
- Run ID footnote in MR summary notes so the trace is locatable from the MR.

[0.3.6]: https://github.com/weareikko/code-review/compare/0.3.5...0.3.6

## [0.3.5] - 2026-05-21

### Added

- Five review-level OTel metrics emitted once per run (`GITLAB_REVIEW_OTEL=1`) ([#37]): `gitlab_review_run_duration_seconds`, `gitlab_review_total_cost_usd`, `gitlab_review_comments_total`, `gitlab_review_drafts_published_total`, and `gitlab_review_phase_duration_seconds`, labelled with status (`success`/`error`/`timeout`); `gitlab.mr_iid` is excluded as high-cardinality.

[0.3.5]: https://github.com/weareikko/code-review/compare/0.3.4...0.3.5
[#37]: https://github.com/weareikko/code-review/pull/37

## [0.3.4] - 2026-05-21

### Added

- GitLab CI project attributes (`gitlab.project_path`, `gitlab.project_namespace`, `gitlab.mr_target_branch`, `gitlab.pipeline_source`) on every OTel metric, span, and log when running in CI; omitted gracefully on local runs.

[0.3.4]: https://github.com/weareikko/code-review/compare/0.3.3...0.3.4

## [0.3.3] - 2026-05-21

### Added

- Richer OTel agent telemetry ([#35]): per-turn `gen_ai.agent.turn` spans and per-call `execute_tool` spans, with per-turn token/cost/TTFT metrics.
- OTel structured log records ([#35]): one `gitlab_review.comment` per comment and one `gitlab_review.completed` per run (requires the Logs Publisher scope).

[0.3.3]: https://github.com/weareikko/code-review/compare/0.3.2...0.3.3
[#35]: https://github.com/weareikko/code-review/pull/35

## [0.3.2] - 2026-05-20

### Added

- Structured `Logger` (`debug`/`info`/`warn`/`error`) with `createLogger` and `noopLogger`; all output to stderr (169c470, #33).
- `--verbose` (or `GITLAB_REVIEW_VERBOSE=true`) enables debug logging — loaded skills/conventions, agent turn numbers, and individual tool calls (169c470, #33).

[0.3.2]: https://github.com/weareikko/code-review/compare/0.3.1...0.3.2

## [0.3.1] - 2026-05-20

### Fixed

- Draft mode: remap `body` → `note` for the draft notes API, which previously rejected every draft inline comment with 400 "note is missing" ([#32]).

[0.3.1]: https://github.com/weareikko/code-review/compare/0.3.0...0.3.1
[#32]: https://github.com/weareikko/code-review/pull/32

## [0.3.0] - 2026-05-19

### Added

- Skills: domain-specific review modules loaded with `--skill <name>` / `GITLAB_REVIEW_SKILLS`, auto-discovered from `.agents/skills/` and `.claude/skills/` (closer and project skills override) ([#31]).
- Built-in `code-review` skill: adversarial correctness reviewer with per-language reference files (JS/TS, PHP/Laravel) ([#31]).
- Active skill names shown in the summary footer and `review-usage.json` ([#31]).
- `runReview` accepts a `timeoutMs` option (default 10 min) so hung LLM calls cannot block CI.
- New `dist/review.js` library build entry; the `"."` package export points to it.
- `typecheck:tests` script and `tsconfig.test.json` extend type-checking to `tests/`.

### Changed

- Switch license from MIT to FSL-1.1-ALv2 (converts to Apache 2.0 two years after each release).
- The summary comment opens with a `## Code Review` heading ([#28]).
- `--skill` is handled natively by `parseArgs` as a multi-value flag.
- `UpsertSummaryOptions` inherits `skillsFooter` instead of re-declaring it.

### Fixed

- Inject today's date into the prompt and ban claims about unverifiable external state (dates, library versions, deprecation) to prevent stale-knowledge hallucinations ([#29]).
- `GitLabClient.request()` only sets `Content-Type: application/json` when a body is present.
- `GitLabClient.paginate()` wraps each page fetch in the same `AbortController` timeout as `request()`.
- Eval helper renamed `hasApiKey` → `missingApiKey` to match its semantics.

[0.3.0]: https://github.com/weareikko/code-review/compare/0.2.0...0.3.0
[#28]: https://github.com/weareikko/code-review/pull/28
[#29]: https://github.com/weareikko/code-review/pull/29
[#31]: https://github.com/weareikko/code-review/pull/31

## [0.2.0] - 2026-05-19

### Added

- Skip the reviewer when the MR head commit already appears in the summary note's reviewed-commit footer; `--force-review` / `GITLAB_REVIEW_FORCE_REVIEW` overrides ([#25], [#26]).

### Changed

- Align project naming to `gitlab-review` across code, markers, OTel naming, the default artifact, and `GITLAB_REVIEW_*` env vars; legacy hidden markers stay readable for migration ([#27]).

[0.2.0]: https://github.com/weareikko/code-review/releases/tag/0.2.0
[#25]: https://github.com/weareikko/code-review/pull/25
[#26]: https://github.com/weareikko/code-review/pull/26
[#27]: https://github.com/weareikko/code-review/pull/27

## [0.1.11] - 2026-05-19

### Changed

- Preserve previous summary runs in a collapsed `Previous review runs` history section (bounded to 10) instead of erasing them ([#24]).

[0.1.11]: https://github.com/weareikko/code-review/releases/tag/0.1.11
[#24]: https://github.com/weareikko/code-review/pull/24

## [0.1.10] - 2026-05-19

### Added

- The summary note includes a cost footer (token counts + USD total) after a horizontal rule ([#22]).

### Changed

- The summary note is upserted before inline comments so it appears at the top of the MR activity feed ([#22]).

[0.1.10]: https://github.com/weareikko/code-review/releases/tag/0.1.10
[#22]: https://github.com/weareikko/code-review/pull/22

## [0.1.9] - 2026-05-19

### Added

- Post the reviewer's `summary` as a non-positional MR note, upserted in place via a hidden `<!-- gitlab-review:summary -->` marker; default-on (`--no-summary` disables), skipped under dry-run/no-post ([#19]).
- New `GitLabClient` methods: `createMergeRequestNote`, `updateMergeRequestNote` ([#19]).
- New `gitlab.upsert_summary` diagnostics channel and OTel attributes ([#19]).
- Emit OTel GenAI client metrics (`gen_ai.client.operation.duration`, `gen_ai.client.token.usage`) alongside spans.

### Changed

- **Breaking (library callers only):** `startOtelBridge`'s `runtime:` now takes `tracerProvider` + `meterProvider` instead of the full `api` namespace; the CLI opt-in is unchanged.

### Fixed

- OTel `service.version` is inlined at build time from `package.json`, so it reads the real version under `npx`/standalone instead of `0.0.0`.

[0.1.9]: https://github.com/weareikko/code-review/releases/tag/0.1.9
[#19]: https://github.com/weareikko/code-review/pull/19

## [0.1.8] - 2026-05-19

### Fixed

- OTel bridge boot crash (`resources.Resource is not a constructor`): use the `@opentelemetry/resources` v2 factory API ([#18]).

[0.1.8]: https://github.com/weareikko/code-review/releases/tag/0.1.8
[#18]: https://github.com/weareikko/code-review/pull/18

## [0.1.7] - 2026-05-19

### Added

- Opt-in OpenTelemetry bridge (`GITLAB_REVIEW_OTEL=1`) emitting GenAI-convention spans with per-run tokens/cost; exporter selection follows the standard `OTEL_*` env vars ([#17]).

[0.1.7]: https://github.com/weareikko/code-review/releases/tag/0.1.7
[#17]: https://github.com/weareikko/code-review/pull/17

## [0.1.6] - 2026-05-19

### Fixed

- Parse JSON review fences whose comment bodies contain nested fenced code blocks (only treat line-start backticks as the closing fence) ([#15]).

### Changed

- Use Codecov OIDC authentication for CI uploads ([#15]).

[0.1.6]: https://github.com/weareikko/code-review/releases/tag/0.1.6
[#15]: https://github.com/weareikko/code-review/pull/15

## [0.1.5] - 2026-05-19

### Added

- `--posting-mode draft` (`GITLAB_REVIEW_POSTING_MODE`) creates draft notes and publishes them atomically via `bulk_publish`, with orphan cleanup, bounded concurrency, a pre-publish fingerprint re-check, and same-run self-heal; default stays `direct` ([#14]).
- New `GitLabClient` draft methods (`getCurrentUser`, `listDraftNotes`, `createDraftNote`, `deleteDraftNote`, `bulkPublishDraftNotes`) ([#14]).
- `gitlab.post_comments` diagnostics expose draft counts ([#14]).

### Changed

- Drafts dropped by the pre-publish re-check are reported separately from duplicates ([#14]).

[0.1.5]: https://github.com/weareikko/code-review/releases/tag/0.1.5
[#14]: https://github.com/weareikko/code-review/pull/14

## [0.1.4] - 2026-05-18

### Added

- Configurable agent `thinkingLevel` via `--thinking <level>` / `GITLAB_REVIEW_THINKING_LEVEL` (`off`…`xhigh`, default `off`); thinking tokens are billed and reported ([#13]).

[0.1.4]: https://github.com/weareikko/code-review/releases/tag/0.1.4
[#13]: https://github.com/weareikko/code-review/pull/13

## [0.1.3] - 2026-05-18

### Fixed

- `formatUsageLine` reports billable input as `input + cacheRead + cacheWrite` so the usage line agrees with the cost when prompt caching is active; adds a `(N cached)` hint ([#12]).

[0.1.3]: https://github.com/weareikko/code-review/releases/tag/0.1.3
[#12]: https://github.com/weareikko/code-review/pull/12

## [0.1.2] - 2026-05-18

### Added

- Own the review pipeline: drive `@earendil-works/pi-agent-core` directly to capture per-run token usage and cost; print a `Review usage:` line and write `review-usage.json` ([#11]).

### Changed

- Replace the bundled `gitlab-review` dependency with direct pinned deps on `@earendil-works/pi-agent-core`, `@earendil-works/pi-ai`, and `@earendil-works/pi-coding-agent`; conventions loading, prompt building, and noise filtering now live here ([#11]).

[0.1.2]: https://github.com/weareikko/code-review/releases/tag/0.1.2
[#11]: https://github.com/weareikko/code-review/pull/11

## [0.1.1] - 2026-05-18

### Fixed

- Forward shell-quoted Git diff arguments to `gitlab-review` instead of raw diff content.

[0.1.1]: https://github.com/weareikko/code-review/releases/tag/0.1.1

## [0.1.0] - 2026-05-18

### Added

- Initial release of `@weareikko/code-review` ([a6166f5], [310dccf]).
- Add package metadata and expanded README usage documentation ([c2a11c0]).
- Add package exports for the CLI entry point and public API type declarations ([5c53a43]).
- Add config validation and argument parsing test coverage ([a167ab1]).
- Add GitHub Actions workflows to run CI checks and publish tagged releases to npm ([4b5920b]).
- Add opt-in `diagnostics_channel` tracing events for the run lifecycle and review phases ([1a610da]).
- Add Vitest coverage reporting and Codecov upload integration ([1a610da]).

### Changed

- Update build and lint tooling ([38190f7]).
- Stop tracking built `dist` files and ignore generated build artifacts ([fa64a59], [64c9d09]).
- Document the `--cwd` flag and simplify the README GitLab CI example ([0bdf985]).
- Update GitHub Actions to Node 24-compatible action versions ([2c4971b]).

### Fixed

- Rename the npm package scope to `@weareikko/code-review` ([c29faef]).
- Add typed runtime errors for clearer CLI failures ([cd4220d]).
- Return an honest intermediate min-severity type before runtime validation ([5c53a43]).

[0.1.0]: https://github.com/weareikko/code-review/releases/tag/0.1.0
[a6166f5]: https://github.com/weareikko/code-review/commit/a6166f5
[310dccf]: https://github.com/weareikko/code-review/commit/310dccf
[c2a11c0]: https://github.com/weareikko/code-review/commit/c2a11c0
[38190f7]: https://github.com/weareikko/code-review/commit/38190f7
[fa64a59]: https://github.com/weareikko/code-review/commit/fa64a59
[64c9d09]: https://github.com/weareikko/code-review/commit/64c9d09
[cd4220d]: https://github.com/weareikko/code-review/commit/cd4220d
[c29faef]: https://github.com/weareikko/code-review/commit/c29faef
[5c53a43]: https://github.com/weareikko/code-review/commit/5c53a43
[0bdf985]: https://github.com/weareikko/code-review/commit/0bdf985
[a167ab1]: https://github.com/weareikko/code-review/commit/a167ab1
[4b5920b]: https://github.com/weareikko/code-review/commit/4b5920b
[1a610da]: https://github.com/weareikko/code-review/commit/1a610da
[2c4971b]: https://github.com/weareikko/code-review/commit/2c4971b
