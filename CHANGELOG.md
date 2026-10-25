## [0.4.29] - 2026-10-25

### Fixed

- A subagent that ends with no answer because of a usage limit now reports `limited` (an error: `failed`), not `completed`.

### Changed

- Web chat: the subagents one message starts are one card ("4 subagents, 1 failed, 1 limited") with a line per subagent (state, label, agent, model, time, first line of its report; tap for the full report and Open session). Result notices, TaskWait, TaskList, TaskResult and TaskContinue fold into it, a later notice leaves a small "updated" line, and no raw `ses_` ids show. A workflow row gets a phase bar and agent counts, and its WorkflowStatus calls fold into it.