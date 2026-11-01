/** highlight.js core with the languages the app shows. Themed by the --syn-* tokens in styles/index.css. */
import hljs from 'highlight.js/lib/core';
import typescript from 'highlight.js/lib/languages/typescript';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import bash from 'highlight.js/lib/languages/bash';
import shell from 'highlight.js/lib/languages/shell';
import python from 'highlight.js/lib/languages/python';
import rust from 'highlight.js/lib/languages/rust';
import go from 'highlight.js/lib/languages/go';
import c from 'highlight.js/lib/languages/c';
import cpp from 'highlight.js/lib/languages/cpp';
import yaml from 'highlight.js/lib/languages/yaml';
import ini from 'highlight.js/lib/languages/ini';
import xml from 'highlight.js/lib/languages/xml';
import css from 'highlight.js/lib/languages/css';
import sql from 'highlight.js/lib/languages/sql';
import diff from 'highlight.js/lib/languages/diff';
import dockerfile from 'highlight.js/lib/languages/dockerfile';
import nginx from 'highlight.js/lib/languages/nginx';
import markdown from 'highlight.js/lib/languages/markdown';
import x86asm from 'highlight.js/lib/languages/x86asm';

const LANGS = { typescript, javascript, json, bash, shell, python, rust, go, c, cpp, yaml, ini, xml, css, sql, diff, dockerfile, nginx, markdown, x86asm };
for (const [name, lang] of Object.entries(LANGS)) if (!hljs.getLanguage(name)) hljs.registerLanguage(name, lang);
hljs.registerAliases(['ts', 'tsx'], { languageName: 'typescript' });
hljs.registerAliases(['js', 'jsx', 'mjs', 'cjs'], { languageName: 'javascript' });
hljs.registerAliases(['sh', 'zsh', 'fish'], { languageName: 'bash' });
hljs.registerAliases(['console'], { languageName: 'shell' });
hljs.registerAliases(['py'], { languageName: 'python' });
hljs.registerAliases(['rs'], { languageName: 'rust' });
hljs.registerAliases(['yml'], { languageName: 'yaml' });
hljs.registerAliases(['toml', 'conf', 'caddyfile', 'systemd'], { languageName: 'ini' });
hljs.registerAliases(['html', 'svg'], { languageName: 'xml' });
hljs.registerAliases(['md'], { languageName: 'markdown' });
hljs.registerAliases(['asm', 'nasm'], { languageName: 'x86asm' });

/** HTML with hljs spans, or null when the language is unknown. */
export function highlight(code: string, lang?: string): string | null {
  try {
    if (lang && hljs.getLanguage(lang)) return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
  } catch {
    /* fall through */
  }
  return null;
}

/** Language id from a file path: "src/auth.ts" -> "typescript". */
export function langFromPath(path: string | undefined): string | undefined {
  const ext = path?.split('.').pop()?.toLowerCase();
  if (!ext || ext === path?.toLowerCase()) return undefined;
  return hljs.getLanguage(ext) ? ext : undefined;
}
