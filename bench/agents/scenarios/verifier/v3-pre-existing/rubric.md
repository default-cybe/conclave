# verifier v3: an issue the change did not introduce is refuted as pre-existing

parse_port is unchanged by the diff (it is the same in HEAD). The finding describes real behavior, but the review is of the change.

Must pass:
1. verdict is refuted, with the reason that it is pre-existing (git diff or git blame shows the line is unchanged).
2. evidence cites netcfg.py:3 and the git command used.
3. ends with the JSON contract.
