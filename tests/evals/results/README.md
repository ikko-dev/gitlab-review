# Eval results (committed raw data)

Committed backups of measurement-harness output. Distinct from the gitignored
`test-results/` directory (live run output) — these are curated snapshots kept in
version control so the numbers behind the analyses survive.

| File                                | Harness                        | What it is                                                                                                                       |
| ----------------------------------- | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| `swe-prbench-sweep.json`            | `swe-prbench-sweep.eval.ts`    | Per-review records for the luna × depth × thinking sweep on real TS/JS PRs, **file access on** (143/144; `verify/high` = 15/16). |
| `swe-prbench-sweep.md`              | (regenerated)                  | Summary matrices + notes for the above.                                                                                          |
| `swe-prbench-triage.json`           | `swe-prbench-lib.ts`           | Frozen per-PR gold-comment triage (`is_defect`), shared across all sweep cells.                                                  |
| `depth-thinking-sweep.json` / `.md` | `depth-thinking-sweep.eval.ts` | luna × depth × thinking sweep on the **synthetic** fixture suite (patch-only).                                                   |

Reproduce: see `tests/evals/fixtures/swe-prbench/README.md` (materialize + run) and
the header comment in each `*.eval.ts`. Model under test: `openrouter/openai/gpt-5.6-luna`.
Numbers depend on the live LLM, so re-runs will differ; treat these as the snapshot
behind the recorded findings.
