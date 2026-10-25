## [0.4.29] - 2026-10-25

### Changed

- A page change fades the new page in (240ms), and chat rows that arrive together fade in one after another.
- Reduce motion shows each pet and glyph in a still pose; they pause off screen and in background tabs.

### Added

- A pet that shows what agents are doing: idle, thinking, researching, building, testing, reviewing, waiting, parked (asleep until a limit resets), done and failed. It sits on a workflow run's status line, the running tasks pill, the limit notice, the Inbox's open request and Home's first day empty state. Never in a chat reply.
- Agent glyphs: one small mark per agent type (explore, researcher, builder, tester, reviewer, debugger, designer, verifier, general purpose, workflow, delegate) in workflow call rows, the running tasks list and Delegate lines. A light runs along it while the agent works; it turns grey when done, red when failed and amber when waiting. Only three rows move at once.
- See every pet state and glyph at `/dev/motion`.