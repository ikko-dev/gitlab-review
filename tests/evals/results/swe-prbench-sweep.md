# SWE-PRBench depth × thinking sweep (file access) — luna

Model `openrouter/openai/gpt-5.6-luna`, file access on (real checkouts at the reviewed state), gold triage frozen across all cells, 1 trial/cell. 16 TS/JS PRs (`verify/high` has 15 — one review was wedged and abandoned, see note).

_Regenerated from `swe-prbench-sweep.json` (143/144 records). Raw per-review records live in that file._

## Defect recall (matched real defects / real defects)

| depth \ thinking | low        | medium     | high       |
| ---------------- | ---------- | ---------- | ---------- |
| **single**       | 12% (2/16) | 25% (4/16) | 19% (3/16) |
| **verify**       | 12% (2/16) | 12% (2/16) | 19% (3/16) |
| **full**         | 19% (3/16) | 25% (4/16) | 25% (4/16) |

## Findings per PR

| depth \ thinking | low | medium | high |
| ---------------- | --- | ------ | ---- |
| **single**       | 0.5 | 0.6    | 0.9  |
| **verify**       | 0.2 | 0.5    | 0.7  |
| **full**         | 0.8 | 1.1    | 1.6  |

## Fabrication rate (FABRICATED / findings)

| depth \ thinking | low       | medium     | high       |
| ---------------- | --------- | ---------- | ---------- |
| **single**       | 0% (0/8)  | 10% (1/10) | 7% (1/14)  |
| **verify**       | 25% (1/4) | 25% (2/8)  | 9% (1/11)  |
| **full**         | 0% (0/12) | 11% (2/18) | 12% (3/26) |

## $/review (real, cache-aware)

| depth \ thinking | low     | medium  | high    |
| ---------------- | ------- | ------- | ------- |
| **single**       | $0.0102 | $0.0265 | $0.0715 |
| **verify**       | $0.0106 | $0.0322 | $0.0713 |
| **full**         | $0.0351 | $0.0757 | $0.2153 |

## p50 latency (s)

| depth \ thinking | low | medium | high |
| ---------------- | --- | ------ | ---- |
| **single**       | 29  | 68     | 137  |
| **verify**       | 35  | 82     | 142  |
| **full**         | 35  | 81     | 178  |

## Notes

- **Recall is the bottleneck (~25% ceiling), not context or precision.** Even the best cells (`single/medium`, `full/medium`, `full/high`) match only ~25% of the defects human reviewers flagged — vs 95–98% saturation on synthetic fixtures.
- **`verify` hurts on real PRs**: fewest findings/PR and lowest recall (its precision filter over-suppresses when defects are scarce). Opposite of its synthetic-fixture behaviour.
- **`single/medium` ≈ `full/medium` recall at ~⅓ the cost** — value pick. `high` thinking adds no recall over `medium` but 2–3× cost/latency and more fabrication.
- **Caveat:** N=16 PRs, 1 trial, 16 total real defects — single-cell differences of 1–2 defects are noise. Trust the broad patterns, not exact cell values.
- **Timeout bug observed:** the `verify/high` review on `stylelint__8953` ran >25 min without the 10-min per-stage timeout firing; abandoned (that cell = 15/16). Worth a follow-up on timeout enforcement around the verify stage.
