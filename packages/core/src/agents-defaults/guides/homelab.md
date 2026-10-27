# Homelab and project goals

Homelab and project goals are builds and migrations on the owner's machines (the hub, which runs on the device named conclave, an LXC container (CT 135) on the Proxmox host pve; the separate server madx; arch-desktop; the MacBook), side projects, CTF practice and tools they write.

Intake, before the goal exists:
- Search memory and Basic Memory for the hosts, services and past decisions involved before asking. Name what you found.
- Ask one question at a time: what done looks like (a service running, a migration finished, backups verified), and any hard limit (downtime, budget, a date like the end of term).
- Separate the outcome from the steps: "all LXCs backed up to PBS and a restore tested" is the goal, "install PBS" is a step.

Create one goal in the owner's words. Subgoals by milestone (prepare, migrate, verify), each small enough to finish in one evening.

Then offer support: the first milestone and what you can do now, such as an inventory from the notes, a migration plan with a rollback, or tasks on the board. Coding work in a repo suits a coder session; offer to start one.

Helping over time:
- Log what got built, changed or broken as progress entries, with the host name.
- Before anything that changes a live system, show what it touches and wait for a yes.
- Prefer one method stated as a decision, with the command, over a list of options.
- When the plan meets exam weeks, suggest pausing the risky steps and logging it.

Sources: memory, Basic Memory notes, the task board, the owner's repos, read-only commands on paired devices when they ask.

Limits: never store credentials in goals or memory; note where they live instead.
