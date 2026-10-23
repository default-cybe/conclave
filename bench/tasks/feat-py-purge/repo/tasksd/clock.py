"""Time sources. Everything that needs "now" takes a clock, so tests can use FakeClock."""

import time


class Clock:
    """Wall clock. now_ms() is milliseconds since the epoch, now_s() whole seconds."""

    def now_ms(self) -> int:
        return int(time.time() * 1000)

    def now_s(self) -> int:
        return self.now_ms() // 1000


class FakeClock(Clock):
    """A clock that only moves when told to."""

    def __init__(self, start_ms: int = 1_772_323_200_000):  # 2026-03-01T00:00:00Z
        self._ms = int(start_ms)

    def now_ms(self) -> int:
        return self._ms

    def advance(self, ms: float) -> None:
        self._ms += int(ms)

    def set(self, ms: int) -> None:
        self._ms = int(ms)
