import { describe, expect, test } from 'bun:test';
import { bashRuleTargets, checkPermission, type CheckInput } from '../../src/session/permissions';
import { gatedConstructs, HEREDOC_WORD, maskSafeHeredocs, substitutionBodies, suggestBashRule } from '../../src/tools/bash-rules';
import { toolByName } from '../../src/tools';
import type { PermissionMode } from '../../src/types';

const bash = toolByName('Bash')!;

function check(command: string, rules: { allow?: string[]; deny?: string[]; ask?: string[] } = {}, mode: PermissionMode = 'default', sessionAllow: string[] = []) {
  const c: CheckInput = {
    tool: bash,
    input: { command },
    content: command.trim(),
    mode,
    rules: { allow: rules.allow ?? [], deny: rules.deny ?? [], ask: rules.ask ?? [] },
    sessionAllow,
    cwd: '/work',
    home: '/home/me',
    workspaceRoots: ['/work'],
  };
  return checkPermission(c);
}

describe('prefix allow rules and gated constructs', () => {
  const cases: Array<[string, string, string]> = [
    ['git status $(touch /tmp/pwn)', 'Bash(git status:*)', 'command substitution'],
    ['git status `id`', 'Bash(git status:*)', 'command substitution'],
    ['echo hi > ~/.bashrc', 'Bash(echo:*)', 'redirect to file'],
    ['echo $(curl x)', 'Bash(echo:*)', 'command substitution'],
    ['echo "$(curl x)"', 'Bash(echo:*)', 'command substitution'],
    ['cat <(curl x)', 'Bash(cat:*)', 'process substitution'],
    ['git status & rm -rf build', 'Bash(git status:*)', 'background job'],
    ['echo hi >> notes.txt', 'Bash(echo:*)', 'redirect to file'],
    ['cat a <> b', 'Bash(cat:*)', 'read-write redirect'],
  ];
  for (const [cmd, rule, construct] of cases) {
    test(`${cmd} asks under ${rule}`, () => {
      const r = check(cmd, { allow: [rule] });
      expect(r.decision).toBe('ask');
      expect(r.reason).toContain(construct);
      expect(r.reason).toContain(rule);
    });
  }

  test('the reason text names the construct and the rule', () => {
    expect(check('git status $(touch /tmp/pwn)', { allow: ['Bash(git status:*)'] }).reason).toBe('Needs approval: command substitution is not covered by Bash(git status:*)');
  });

  test('chained commands still all need a rule (unchanged)', () => {
    expect(check('git status; rm x', { allow: ['Bash(git status:*)'] }).decision).toBe('ask');
    expect(check('git status && git diff', { allow: ['Bash(git status:*)', 'Bash(git diff:*)'] }).decision).toBe('allow');
  });

  test('redirects to /dev/null and fd duplication stay allowed', () => {
    expect(check('npm test 2>/dev/null', { allow: ['Bash(npm test:*)'] }).decision).toBe('allow');
    expect(check('npm test 2>&1 | tail -20', { allow: ['Bash(npm test:*)', 'Bash(tail:*)'] }).decision).toBe('allow');
    expect(check('npm test > /dev/null 2>&1', { allow: ['Bash(npm test:*)'] }).decision).toBe('allow');
  });

  test('single quotes keep $( ) literal', () => {
    expect(check("echo '$(not run)'", { allow: ['Bash(echo:*)'] }).decision).toBe('allow');
  });

  test('an exact rule naming the whole command allows it', () => {
    expect(check('git status $(date)', { allow: ['Bash(git status $(date))'] }).decision).toBe('allow');
    expect(check('echo hi > out.txt', { allow: ['Bash(echo hi > out.txt)'] }).decision).toBe('allow');
    // the same through a session grant
    expect(check('echo hi > out.txt', {}, 'default', ['Bash(echo hi > out.txt)']).decision).toBe('allow');
  });

  test('glob rules count as prefix rules', () => {
    const r = check('touch a > b', { allow: ['Bash(touch *)'] });
    expect(r.decision).toBe('ask');
    expect(r.reason).toContain('redirect to file');
  });

  test('a bare Bash rule still allows every command', () => {
    expect(check('git status $(date) > x', { allow: ['Bash'] }).decision).toBe('allow');
  });

  test('bypass mode still allows', () => {
    expect(check('git status $(touch /tmp/pwn)', { allow: ['Bash(git status:*)'] }, 'bypass').decision).toBe('allow');
  });

  test('without any rule the plain reason is kept', () => {
    expect(check('echo hi > x').reason).toBe('Needs approval');
  });

  test('suggested rules for gated commands are exact, so "always allow" covers them', () => {
    expect(suggestBashRule('echo hi > out.txt')).toBe('Bash(echo hi > out.txt)');
    expect(suggestBashRule('npm run dev &')).toBe('Bash(npm run dev &)');
    const rule = suggestBashRule('git status $(date)')!;
    expect(check('git status $(date)', { allow: [rule] }).decision).toBe('allow');
  });
});

describe('deny and ask rules see every command a line runs', () => {
  test('a deny rule hit inside a pipeline denies', () => {
    expect(check('ls | rm -rf x', { allow: ['Bash'], deny: ['Bash(rm:*)'] }).decision).toBe('deny');
  });

  test('a deny rule hit inside $( ) or backticks denies, even in bypass mode', () => {
    expect(check('echo $(rm -rf x)', { deny: ['Bash(rm:*)'] }, 'bypass').decision).toBe('deny');
    expect(check('echo `rm -rf x`', { deny: ['Bash(rm:*)'] }).decision).toBe('deny');
    expect(check('echo "$(echo $(rm -rf x))"', { deny: ['Bash(rm:*)'] }).decision).toBe('deny');
  });

  test('a deny rule hit after a single & or inside a subshell denies', () => {
    expect(check('git status & rm -rf x', { deny: ['Bash(rm:*)'] }, 'bypass').decision).toBe('deny');
    expect(check('(rm -rf x)', { deny: ['Bash(rm:*)'] }, 'bypass').decision).toBe('deny');
  });

  test('an ask rule hit in a later sub-command asks even when allow rules cover every part', () => {
    const r = check('ls && git push', { allow: ['Bash(ls:*)', 'Bash(git:*)'], ask: ['Bash(git push:*)'] });
    expect(r.decision).toBe('ask');
    expect(r.rule).toBe('Bash(git push:*)');
  });
});

describe('helpers', () => {
  test('gatedConstructs lists each kind once', () => {
    expect(gatedConstructs('echo $(a) $(b) > f')).toEqual(['command substitution', 'redirect to file']);
    expect(gatedConstructs('npm test 2>/dev/null')).toEqual([]);
    expect(gatedConstructs('cat <<EOF\nx\nEOF')).toEqual([]);
    expect(gatedConstructs('(cd x && make)')).toEqual(['subshell']);
    expect(gatedConstructs('echo $(a) (b)')).toEqual(['command substitution', 'subshell']);
  });

  test('substitutionBodies finds nested and quoted bodies', () => {
    expect(substitutionBodies('echo $(a $(b)) `c` "$(d)" \'$(e)\' <(f)')).toEqual(['a $(b)', 'b', 'c', 'd', 'f']);
    expect(substitutionBodies('echo $(unclosed')).toEqual(['unclosed']);
  });

  test('bashRuleTargets covers parts, groups and substitutions', () => {
    const t = bashRuleTargets('(cd x && make) | tee $(rm y)');
    expect(t).toContain('make');
    expect(t).toContain('rm y');
    expect(t).toContain('cd x');
  });
});

describe('commit messages through $(cat <<\'EOF\' ... EOF)', () => {
  // the form the Bash tool description asks for
  const commit = "git commit -m \"$(cat <<'EOF'\nfix(core): don't drop notes\n\nCo-Authored-By: x\nEOF\n)\"";

  test('a prefix rule covers it, as in Claude Code, and the suggestion is the prefix rule', () => {
    expect(gatedConstructs(commit)).toEqual([]);
    expect(check(commit, { allow: ['Bash(git commit:*)'] }).decision).toBe('allow');
    expect(suggestBashRule(commit)).toBe('Bash(git commit:*)');
    expect(maskSafeHeredocs(commit)).toBe(`git commit -m "${HEREDOC_WORD}"`);
    // <<-, <<"EOF" and <<\EOF quote the delimiter too
    expect(check("git commit -m \"$(cat <<-'EOF'\n\tmsg\n\tEOF\n)\"", { allow: ['Bash(git commit:*)'] }).decision).toBe('allow');
    expect(check('git commit -m "$(cat <<"EOF"\nmsg\nEOF\n)"', { allow: ['Bash(git commit:*)'] }).decision).toBe('allow');
    expect(check('git commit -m "$(cat <<\\EOF\nmsg\nEOF\n)"', { allow: ['Bash(git commit:*)'] }).decision).toBe('allow');
  });

  test('lines of the message are text: a deny rule does not match them, but a real command after it does', () => {
    const msg = "git commit -m \"$(cat <<'EOF'\nrm -rf build is gone\nEOF\n)\"";
    expect(check(msg, { allow: ['Bash'], deny: ['Bash(rm:*)'] }).decision).toBe('allow');
    expect(check(`${msg} && rm -rf x`, { allow: ['Bash'], deny: ['Bash(rm:*)'] }).decision).toBe('deny');
    expect(check(`${msg} && rm -rf x`, { allow: ['Bash(git commit:*)'] }).decision).toBe('ask');
  });

  const asks: Array<[string, string]> = [
    ['an unquoted delimiter expands $( ) in the body', 'git commit -m "$(cat <<EOF\nfix $(touch x)\nEOF\n)"'],
    ['a delimiter line before the real end ends the body early', "git commit -m \"$(cat <<'EOF'\nhi\nEOF\ntouch x\nEOF\n)\""],
    ['text after the delimiter on the opening line runs', "git commit -m \"$(cat <<'EOF'; touch x\nhi\nEOF\n)\""],
    ['a ) in the body that a paren scanner would stop at', "git commit -m \"$(cat <<'EOF'\nx)\"; touch x; echo \"\nEOF\n)\""],
    ['a comment before it can hide a quote from the scanner', "echo hi # '\necho '$(cat <<'D'\n'; touch x; '\nD\n)'"],
    ["$'...' quoting before it", "echo $'a\\' $(cat <<'D'\n'; touch x; '\nD\n)'"],
    ['not cat', "git commit -m \"$(sh <<'EOF'\ntouch x\nEOF\n)\""],
  ];
  for (const [why, cmd] of asks) {
    test(`asks when ${why}`, () => {
      expect(check(cmd, { allow: ['Bash(git commit:*)', 'Bash(echo:*)'] }).decision).toBe('ask');
    });
  }

  test('inside single quotes it is plain text and stays as it is', () => {
    const cmd = "echo '$(cat <<'EOF'\nx\nEOF\n)'";
    expect(maskSafeHeredocs(cmd)).toBe(cmd);
  });
});

describe('suggested exact rules cover their command', () => {
  test('with a * in the command', () => {
    const cmd = 'ls *.txt > out.txt';
    const rule = suggestBashRule(cmd)!;
    expect(rule).toBe('Bash(ls *.txt > out.txt)');
    expect(check(cmd, { allow: [rule] }).decision).toBe('allow');
    // still literal: another redirect target is not covered
    expect(check('ls *.txt > other.txt', { allow: [rule] }).decision).toBe('ask');
  });

  test('over several lines', () => {
    const cmd = "cat > notes.md <<'EOF'\nhello\nEOF";
    const rule = suggestBashRule(cmd)!;
    expect(check(cmd, { allow: [rule] }).decision).toBe('allow');
    expect(check(cmd, {}, 'default', [rule]).decision).toBe('allow');
    expect(check("cat > notes.md <<'EOF'\nbye\nEOF", { allow: [rule] }).decision).toBe('ask');
  });
});

describe('a quote ends where bash ends it', () => {
  // each one runs `touch pwned` in bash; a scanner that misread the quoting hid it inside one quoted word
  const hidden: Array<[string, string]> = [
    ["$'...' with an escaped quote", "echo $'\\'' ; touch pwned ; echo \\'"],
    ['an escaped quote outside quotes', "echo \\' ; touch pwned ; echo \\'"],
    ['a quote in a comment', "echo hi # it's\ntouch pwned\necho \\'"],
    ['a quote in a heredoc body', "cat <<'EOF'\ncat it's\nEOF\ntouch pwned\necho \\'"],
  ];
  for (const [why, cmd] of hidden) {
    test(why, () => {
      expect(check(cmd, {}, 'plan').decision).toBe('deny');
      expect(check(cmd, { allow: ['Bash(echo:*)', 'Bash(cat:*)'] }).decision).toBe('ask');
      expect(check(cmd, { deny: ['Bash(touch:*)'] }, 'bypass').decision).toBe('deny');
    });
  }

  test('a substitution in or after an expanded heredoc body with a quote is seen', () => {
    expect(check("cat <<EOF\nit's $(touch pwned)\nEOF", { deny: ['Bash(touch:*)'] }, 'bypass').decision).toBe('deny');
    expect(check("cat <<EOF\nit's\nEOF\necho $(touch pwned)", { deny: ['Bash(touch:*)'] }, 'bypass').decision).toBe('deny');
    expect(check("echo hi # it's\necho $(touch pwned)", { deny: ['Bash(touch:*)'] }, 'bypass').decision).toBe('deny');
  });

  test('a <<< here-string opens no heredoc body', () => {
    expect(check("cat <<<'x'\n$(touch pwned)\nx", { deny: ['Bash(touch:*)'] }, 'bypass').decision).toBe('deny');
  });

  test('a quoted heredoc body stays text', () => {
    expect(check("cat <<'EOF'\nit's $(touch pwned)\nEOF", { allow: ['Bash'], deny: ['Bash(touch:*)'] }).decision).toBe('allow');
    expect(gatedConstructs("cat <<'EOF'\nit's\nEOF")).toEqual([]);
  });
});
