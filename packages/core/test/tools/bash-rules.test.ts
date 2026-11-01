import { describe, expect, test } from 'bun:test';
import { isReadOnlyCommand, parseCommand, suggestBashRule } from '../../src/tools/bash-rules';

describe('isReadOnlyCommand', () => {
  const yes = [
    'ls',
    'ls -la /tmp',
    'cat README.md',
    'head -n 20 file.txt',
    'tail -f log.txt',
    'grep -rn "foo" src',
    'rg TODO',
    'find . -name "*.ts"',
    'git status',
    'git log --oneline -5',
    'git diff HEAD~1',
    'git show abc123',
    'git branch',
    'git branch -a',
    'git --no-pager log',
    'git -C repo status',
    'pwd',
    'echo hello',
    'which bun',
    'wc -l file',
    'file x.bin',
    'stat x',
    'du -sh .',
    'df -h',
    'env',
    'uname -a',
    'cat a.txt | grep foo | wc -l',
    'ls && pwd',
    'ls 2>/dev/null',
    'ls 2>&1 | head',
    'cd src && ls',
    'echo "a > b"',
    "grep 'x|y' file",
  ];
  const no = [
    'rm -rf build',
    'echo hi > out.txt',
    'cat a >> b',
    'ls; rm x',
    'find . -delete',
    'find . -name x -exec rm {} \\;',
    'git commit -m x',
    'git push',
    'git branch newbranch',
    'git branch -D old',
    'git -c core.pager=evil log',
    'git diff --output=x.patch',
    'echo $(whoami)',
    'echo `id`',
    'ls & rm x',
    'npm install',
    'env rm -rf /',
    'PAGER=evil git log',
    'sort -o out.txt in.txt',
    'cat <(ls)',
    'rg --pre ./script foo',
    // these flags run another program
    'git grep -Orm -e x',
    'git grep --open-files-in-pager=rm x',
    'rg --hostname-bin=./script x',
    'sort --compress-program=./script big.txt',
    'date -s "2020-01-01"',
    '(cd x && ls)',
    'sudo ls',
    'cat <<EOF\nhi\nEOF',
    '',
  ];
  for (const c of yes) test(`read-only: ${c}`, () => expect(isReadOnlyCommand(c)).toBe(true));
  for (const c of no) test(`not read-only: ${JSON.stringify(c)}`, () => expect(isReadOnlyCommand(c)).toBe(false));
});

describe('parseCommand', () => {
  test('splits on operators outside quotes', () => {
    const p = parseCommand(`echo "a && b" && ls -l | wc`);
    expect(p.segments).toEqual([['echo', 'a && b'], ['ls', '-l'], ['wc']]);
    expect(p.separators).toEqual(['&&', '|']);
    expect(p.unsafe).toEqual([]);
  });
  test('flags substitution inside double quotes but not single quotes', () => {
    expect(parseCommand(`echo "$(id)"`).unsafe).toContain('command substitution');
    expect(parseCommand(`echo '$(id)'`).unsafe).toEqual([]);
  });
});

describe('suggestBashRule', () => {
  const cases: Array<[string, string | undefined]> = [
    ['npm test', 'Bash(npm test:*)'],
    ['npm test -- --watch', 'Bash(npm test:*)'],
    ['git commit -m "x"', 'Bash(git commit:*)'],
    ['npm run build', 'Bash(npm run build:*)'],
    ['bun run dev --port 3000', 'Bash(bun run dev:*)'],
    ['cd app && pytest -x', 'Bash(pytest:*)'],
    ['python3 -m pytest tests', 'Bash(python3 -m pytest:*)'],
    ['cargo build --release 2>&1 | tail -20', 'Bash(cargo build:*)'],
    ['docker compose up -d', 'Bash(docker compose up:*)'],
    ['rm -rf dist', 'Bash(rm -rf dist)'],
    ['python -c "print(1)"', 'Bash(python -c "print(1)")'],
    ['make', 'Bash(make:*)'],
  ];
  for (const [cmd, rule] of cases) test(cmd, () => expect(suggestBashRule(cmd)).toBe(rule));
});
