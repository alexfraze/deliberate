"""Estimating how big a prompt is, without asking the API.

Budgeting happens inside a turn, so it must not cost a network round trip. This is a
local estimate, calibrated against the real tokenizer and deliberately biased to read
high.
"""

from __future__ import annotations

import json
from typing import Any

#: Characters per token, measured against `messages.count_tokens` on real payloads of the
#: shapes this service actually sends:
#:
#:     tools + system only   2.65      ledger block   2.49
#:     prose-heavy turn      2.67      JSON state     2.57
#:
#: The familiar "~4 characters per token" is for English prose with no structure. Most of
#: this prompt is JSON -- fifteen tool schemas, a state summary, a ledger -- which tokenizes
#: far denser, and using 4 here under-counted the real prompt by about 40%: a "12k budget"
#: was letting 20k through. 2.5 sits at the dense end of the measured range, so the estimate
#: errs high; shedding a little memory too early is a far cheaper mistake than blowing the
#: context budget.
CHARS_PER_TOKEN = 2.5


def estimate_tokens(value: Any) -> int:
    """Cheap local estimate of a payload's token count.

    Deliberately local, and deliberately an estimate: budgeting must not cost a network round
    trip inside a turn. Used for trimming decisions and for reporting a turn's prompt size,
    never for billing. `tests/test_live.py` re-checks the calibration against the real
    tokenizer so it cannot silently drift.
    """
    text = json.dumps(value, ensure_ascii=False, default=str)
    return max(1, int(len(text) / CHARS_PER_TOKEN))
