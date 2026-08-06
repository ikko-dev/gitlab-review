# Depth × thinking sweep — openrouter/openai/gpt-5.6-luna

## Accuracy (correct vs expected, all judges)

| depth \ thinking | off | low | medium | high |
| ---------------- | --- | --- | ------ | ---- |
| **single**       | 95% | 97% | 97%    | 98%  |
| **verify**       | 97% | 96% | 96%    | 98%  |
| **full**         | 97% | 95% | 97%    | 96%  |

## Cost — $/review (real, cache-aware)

| depth \ thinking | off      | low      | medium   | high     |
| ---------------- | -------- | -------- | -------- | -------- |
| **single**       | $0.00167 | $0.00212 | $0.00282 | $0.00558 |
| **verify**       | $0.00199 | $0.00236 | $0.00323 | $0.00604 |
| **full**         | $0.00559 | $0.00721 | $0.01005 | $0.01692 |

## Latency — p50 (s)

| depth \ thinking | off | low  | medium | high |
| ---------------- | --- | ---- | ------ | ---- |
| **single**       | 4.8 | 7.8  | 10.1   | 15.4 |
| **verify**       | 5.9 | 8.5  | 13.3   | 16.6 |
| **full**         | 8.7 | 11.1 | 16.1   | 23.8 |

## Latency — p95 (s)

| depth \ thinking | off  | low  | medium | high |
| ---------------- | ---- | ---- | ------ | ---- |
| **single**       | 12.7 | 16.0 | 20.1   | 49.4 |
| **verify**       | 15.1 | 17.4 | 24.2   | 47.4 |
| **full**         | 14.3 | 23.4 | 34.5   | 60.3 |

## Per-cell detail

| depth  | thinking | acc | recall | precision | format | context | $/review | avg tokens | p50 s | errors |
| ------ | -------- | --- | ------ | --------- | ------ | ------- | -------- | ---------- | ----- | ------ |
| single | off      | 95% | 100%   | 94%       | 83%    | 78%     | $0.00167 | 8,493      | 4.8   | 0      |
| single | low      | 97% | 99%    | 100%      | 83%    | 100%    | $0.00212 | 7,913      | 7.8   | 0      |
| single | medium   | 97% | 100%   | 97%       | 83%    | 100%    | $0.00282 | 8,331      | 10.1  | 0      |
| single | high     | 98% | 100%   | 97%       | 89%    | 100%    | $0.00558 | 10,442     | 15.4  | 0      |
| verify | off      | 97% | 96%    | 97%       | 100%   | 100%    | $0.00199 | 10,358     | 5.9   | 0      |
| verify | low      | 96% | 96%    | 91%       | 100%   | 100%    | $0.00236 | 9,142      | 8.5   | 0      |
| verify | medium   | 96% | 93%    | 100%      | 100%   | 100%    | $0.00323 | 9,607      | 13.3  | 0      |
| verify | high     | 98% | 96%    | 100%      | 100%   | 100%    | $0.00604 | 12,545     | 16.6  | 0      |
| full   | off      | 97% | 97%    | 100%      | 100%   | 78%     | $0.00559 | 27,310     | 8.7   | 0      |
| full   | low      | 95% | 96%    | 100%      | 100%   | 56%     | $0.00721 | 27,221     | 11.1  | 0      |
| full   | medium   | 97% | 96%    | 100%      | 100%   | 89%     | $0.01005 | 29,568     | 16.1  | 0      |
| full   | high     | 96% | 96%    | 97%       | 100%   | 89%     | $0.01692 | 36,363     | 23.8  | 0      |

_Model: openrouter/openai/gpt-5.6-luna. Accuracy = judge score matched the expected value (diagnostic judges excluded). Cost/tokens are real, computed by pi-ai (cache-aware). Latency is wall-clock per review at concurrency > 1, so treat it as relative between cells, not an absolute single-review time._
