"""Estimating how big a prompt is, without asking the API.

Budgeting happens inside a turn, so it must not cost a network round trip. This is a
local estimate, calibrated against the real tokenizer and deliberately biased to read
high.
"""

from __future__ import annotations

import json
from typing import Any

#: Characters per token, measured against `messages.count_tokens` on real payloads of the
#: shapes this service actually sends. Two rounds of measurement, and the second matters more:
#:
#:     ONE COMPONENT AT A TIME (ALE-15)        A WHOLE ASSEMBLED REQUEST (ALE-45)
#:     tools + system only   2.65              1 map, 3 people          2.468
#:     prose-heavy turn      2.67              12 maps, 96 people       2.477
#:     ledger block          2.49              30 maps, 360 people      2.484
#:     JSON state            2.57              200 maps, 5000 people    2.484
#:
#: The familiar "~4 characters per token" is for English prose with no structure. Most of this
#: prompt is JSON -- seventeen tool schemas, a state summary, a ledger -- which tokenizes far
#: denser, and using 4 here under-counted the real prompt by about 40%: a "12k budget" was
#: letting 20k through.
#:
#: 2.5 was chosen as the dense end of the first table and it was not dense enough, because a
#: whole request is denser than any of its parts: the JSON scaffolding that joins them --
#: braces, quoted keys, indentation, `\n` escapes -- is the densest text in it. At 2.5 the
#: estimate read about 1% *under* the real count on every size above, which is invisible until
#: something sits near the ceiling and then is exactly the bug it was meant to prevent: ALE-45's
#: 30-map turn estimated 11,981 against a real 12,057, and a budget test passed on it.
#:
#: 2.45 is below the densest whole request measured, so the estimate now reads 1-2% high
#: everywhere rather than 1% low. That is the direction the error has to point: shedding a
#: little memory too early is a far cheaper mistake than blowing the context budget.
#: `tests/test_live.py` re-measures both tables.
CHARS_PER_TOKEN = 2.45


def estimate_tokens(value: Any) -> int:
    """Cheap local estimate of a payload's token count.

    Deliberately local, and deliberately an estimate: budgeting must not cost a network round
    trip inside a turn. Used for trimming decisions and for reporting a turn's prompt size,
    never for billing. `tests/test_live.py` re-checks the calibration against the real
    tokenizer so it cannot silently drift.
    """
    text = json.dumps(value, ensure_ascii=False, default=str)
    return max(1, int(len(text) / CHARS_PER_TOKEN))
