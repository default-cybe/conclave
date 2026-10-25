## [0.4.29] - 2026-10-25

### Added

- `GET /api/assistant/home` returns the caller's assistant conversation, made the first time, in the same shape as `GET /api/sessions/:id`.
- Routines take `sessionPolicy: 'home'`: a run is one turn in the assistant conversation, marked as from the routine, and its rules and unattended refusals apply to that turn only. Webhook runs and watches never use it.

### Changed

- The assistant is one conversation per account. Home's composer in Assistant mode, Plan my day and Goals send into it instead of starting a new session each time. Older assistant chats stay in the sidebar under History, and "New assistant chat" is gone.
- The Morning brief posts into the assistant conversation. The Heartbeat still runs in its own session.