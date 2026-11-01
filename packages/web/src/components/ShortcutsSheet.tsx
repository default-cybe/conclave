/** Keyboard shortcuts (spec 11.14): ? opens it. Three groups as tables. */
import { useUi } from '@/store/ui';
import { Dialog } from './ui/Overlay';
import { Kbd, MOD } from './ui/Kbd';

const SHIFT = '⇧';

const GROUPS: Array<{ title: string; items: Array<[string, string[], boolean?]> }> = [
  {
    title: 'Anywhere',
    items: [
      ['Command palette', [MOD, 'K']],
      ['New chat', [MOD, SHIFT, 'O']],
      ['New session', [MOD, 'N']],
      ['Go to Home, Chat, Sessions, Inbox, Tasks', ['G', 'H C S I T'], true],
      ['Go to Routines, Agents, Extensions, Memory', ['G', 'R A E M'], true],
      ['Go to Usage, Devices, Settings', ['G', 'U D ,'], true],
      ['Settings', [MOD, ',']],
      ['Show or hide the sidebar', [MOD, '\\']],
      ['This sheet', ['?']],
      ['Toggle theme', [MOD, '.']],
    ],
  },
  {
    title: 'Home and Chat',
    items: [
      ['Type a message', ['/']],
      ['Send, or start the session', ['↵']],
      ['New line', [SHIFT, '↵']],
      ['Stop the reply', ['esc']],
      ['Leave the box on Home', ['esc']],
      ['Edit your last message', ['↑']],
    ],
  },
  {
    title: 'Sessions',
    items: [
      ['Steer now', [MOD, '↵']],
      ['Copy last code block', [MOD, SHIFT, 'C']],
      ['Next session', [']']],
      ['Previous session', ['[']],
      ['Session panel', [MOD, SHIFT, '\\']],
    ],
  },
  {
    title: 'Lists and Inbox',
    items: [
      ['Move', ['J', 'K']],
      ['Open', ['↵']],
      ['Allow once', ['A']],
      ['Allow for session', ['S']],
      ['Deny', ['D']],
      ['Archive', ['E']],
    ],
  },
];

export function ShortcutsSheet() {
  const open = useUi((s) => s.shortcutsOpen);
  const set = useUi((s) => s.set);
  return (
    <Dialog open={open} onClose={() => set({ shortcutsOpen: false })} title="Keyboard shortcuts" width={640} top="10vh">
      <div className="grid gap-x-8 gap-y-6 pt-2 md:grid-cols-2">
        {GROUPS.map((g, gi) => (
          <section key={g.title} className={gi === 0 ? 'md:col-span-2' : undefined}>
            <h3 className="border-b border-rule-2 pb-[9px] text-[13px] font-semibold text-fg">{g.title}</h3>
            <table className="w-full border-collapse text-[13px]">
              <tbody>
                {g.items.map(([label, keys, then]) => (
                  <tr key={label} className="border-b border-rule last:border-0">
                    <td className="py-[7px] pr-4 text-fg-2">{label}</td>
                    <td className="py-[7px] text-right whitespace-nowrap">
                      <span className="inline-flex items-center gap-1">
                        {keys.map((k, i) => (
                          <span key={k + i} className="inline-flex items-center gap-1">
                            {then && i > 0 && <span className="text-[12px] text-fg-3">then</span>}
                            <Kbd>{k}</Kbd>
                          </span>
                        ))}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        ))}
      </div>
    </Dialog>
  );
}
