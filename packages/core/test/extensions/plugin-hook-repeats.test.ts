/**
 * Extensions > Hooks lint for plugin hooks: two plugins on one event is
 * normal and both run (no warning); one plugin with the same command twice
 * on one event and matcher runs it twice (a warning).
 */
import { expect, test } from 'bun:test';
import { pluginHookRepeats } from '../../src/engine/extensions-api';

const cmd = (plugin: string, command: string) => ({ type: 'command', command, plugin });

test('two plugins that both add a SubagentStart hook get no warning', () => {
  expect(pluginHookRepeats({ SubagentStart: [{ hooks: [cmd('caveman', 'caveman-inject.sh')] }, { matcher: '*', hooks: [cmd('ponytail', 'ponytail-inject.sh')] }] })).toEqual([]);
  // the same command from two plugins is two plugins, not a repeat
  expect(pluginHookRepeats({ SubagentStart: [{ hooks: [cmd('a', 'x.sh')] }, { hooks: [cmd('b', 'x.sh')] }] })).toEqual([]);
});

test('one plugin with the same command twice on one event and matcher is warned once', () => {
  const issues = pluginHookRepeats({
    SubagentStart: [{ hooks: [cmd('caveman', 'inject.sh'), cmd('caveman', 'inject.sh')] }, { matcher: '*', hooks: [cmd('caveman', 'inject.sh')] }],
    // other matchers are other tools: not a repeat
    PreToolUse: [{ matcher: 'Bash', hooks: [cmd('guard', 'check.sh')] }, { matcher: 'Edit', hooks: [cmd('guard', 'check.sh')] }],
  });
  expect(issues).toEqual([{ level: 'warn', event: 'SubagentStart', group: 0, plugins: ['caveman'], text: 'caveman registers the same command twice on SubagentStart, so it runs twice: inject.sh' }]);
});
