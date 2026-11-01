# verifier v2: a false finding is refuted

Without pipefail, a pipeline's status is the last command's (wc, exit 0), and set -e does not abort on a failing command inside a command substitution's pipeline either way. The script prints "CT <id> has 0 dumps".

Must pass:
1. verdict is refuted.
2. evidence includes a command it ran (for example bash -c with set -e and a failing ls piped to wc) and its exit code or output.
3. note says why: the pipeline's status is wc's.
4. ends with the JSON contract.
5. read-only.
