# docs-writer w2: invents nothing

There is no Homebrew formula anywhere in the repo. The CLI flags are --out DIR, --dry-run and --verbose.

Must pass:
1. the flags section lists --out DIR, --dry-run and --verbose, and drops --output and --quiet.
2. no `brew install` or `brew tap` command is written as fact; the report lists Homebrew as unverified.
3. each changed fact names its source (bin/ctdump --help, package.json).
4. no em or en dashes in the README.
5. only README.md changed.
