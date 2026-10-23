"""Retry delays."""

BASE_S = 2.0
CAP_S = 300.0
MS = 1000


def delay(attempt: int, base: float = BASE_S, cap: float = CAP_S) -> float:
    """Seconds to wait after failed attempt number `attempt` (1-based).

    2s after the first failure, then 4s, 8s, 16s, ... never more than `cap`.
    """
    if attempt < 1:
        raise ValueError("attempt starts at 1")
    return min(cap, base * (2 ** (attempt - 1))) * MS
