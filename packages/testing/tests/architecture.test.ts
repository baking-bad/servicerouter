import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

// Reads every package's src/ and checks the rules in docs/architecture/README.md section 1.4 and CK-5.

const packagesRoot = fileURLToPath(new URL('../../', import.meta.url));

// Internal packages each package may import. Apps (proxy, api, workers) and testing aren't listed: they may import any.
const allowedImports: Readonly<Record<string, readonly string[]>> = {
  common: [],
  core: ['common'],
  db: ['core', 'common'],
  payments: ['core', 'common'],
  signer: ['common'],
  // WB-2: the website reads only the public Platform API, over HTTP
  web: [],
};

// Where a package's source lives: src/, and the website's Next.js routes in app/
const sourceDirectories = ['src', 'app'];

// PR-11: payments knows no HTTP framework or database. Adapters, such as one from Fastify to Fetch for
// mppx's HTTP handlers, live in the apps.
const frameworkImport = /^(?:fastify|@fastify\/|drizzle-orm|pg$|redis$|mppx\/(?:hono|express|nextjs|elysia|proxy)$)/;

// CK-5: domain code takes the Clock and IdGenerator ports. Crypto randomness such as randomBytes is allowed.
const domainPackages = ['core', 'payments'];
const bannedCalls: readonly (readonly [RegExp, string])[] = [
  [/\bDate\.now\s*\(/g, 'Date.now()'],
  [/\bnew\s+Date\s*\(\s*\)/g, 'new Date()'],
  [/\bnew\s+Date\b(?!\s*\()/g, 'new Date'],
  [/(?<!\bnew\s+)(?<![\w$.])Date\s*\(\s*\)/g, 'Date()'],
  [/\bMath\.random\s*\(/g, 'Math.random()'],
  [/\brandomUUID\s*\(/g, 'randomUUID()'],
];

// Words after which a `/` starts a regular expression rather than a division
const keywordsBeforeExpression = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await',
]);

/**
 * Replaces comments with spaces, and with `literals`, the contents of strings, templates, and regular
 * expressions too. Line breaks stay, so positions still map to lines. Rules then never match code that
 * is only mentioned in a comment or a string.
 */
const blankSource = (source: string, { literals = false } = {}): string => {
  const output = source.split('');
  const word = /[\w$]+/y;
  let index = 0;
  let regexAllowed = true;

  const blank = (from: number, to: number) => {
    for (let position = from; position < to; position++) {
      if (output[position] !== '\n')
        output[position] = ' ';
    }
  };
  const blankLiteral = (from: number, to: number) => {
    if (literals)
      blank(from, to);
  };
  const skipQuoted = (quote: string) => {
    const start = ++index;
    while (index < source.length && source[index] !== quote && source[index] !== '\n')
      index += source[index] === '\\' ? 2 : 1;
    blankLiteral(start, index);
    index++;
  };
  const skipRegex = () => {
    const start = ++index;
    let inClass = false;
    while (index < source.length && source[index] !== '\n' && (source[index] !== '/' || inClass)) {
      const char = source[index];
      if (char === '[')
        inClass = true;
      else if (char === ']')
        inClass = false;
      index += char === '\\' ? 2 : 1;
    }
    blankLiteral(start, index);
    index++;
  };
  // Scans code to the end, or to the `}` that closes a template literal's `${`
  const scanCode = (inTemplate: boolean): void => {
    let depth = 0;
    while (index < source.length) {
      const char = source[index]!;
      const next = source[index + 1];
      if (char === '/' && (next === '/' || next === '*')) {
        const end = next === '/' ? source.indexOf('\n', index) : source.indexOf('*/', index + 2) + 2;
        const stop = end < index + 2 ? source.length : end;
        blank(index, stop);
        index = stop;
      }
      else if (char === '\'' || char === '"') {
        skipQuoted(char);
        regexAllowed = false;
      }
      else if (char === '`') {
        skipTemplate();
        regexAllowed = false;
      }
      else if (char === '/' && regexAllowed) {
        skipRegex();
        regexAllowed = false;
      }
      else if (/[\w$]/.test(char)) {
        word.lastIndex = index;
        const [match] = word.exec(source)!;
        index += match.length;
        regexAllowed = keywordsBeforeExpression.has(match);
      }
      else if (char === '}' && inTemplate && depth === 0) {
        index++;
        return;
      }
      else {
        if (char === '{')
          depth++;
        else if (char === '}')
          depth--;
        if (!/\s/.test(char))
          regexAllowed = !/[)\]}]/.test(char);
        index++;
      }
    }
  };
  const skipTemplate = () => {
    let start = ++index;
    while (index < source.length && source[index] !== '`') {
      if (source[index] === '\\')
        index += 2;
      else if (source[index] === '$' && source[index + 1] === '{') {
        blankLiteral(start, index);
        index += 2;
        scanCode(true);
        start = index;
      }
      else
        index++;
    }
    blankLiteral(start, index);
    index++;
  };

  scanCode(false);

  return output.join('');
};

const importPatterns = [
  // import … from '…', export … from '…', import '…'
  /(?:^|[\s;{}])(?:import|export)\s+(?:type\s+)?(?:[^'"`;]*?\bfrom\s*)?(['"])([^'"\n]+)\1/g,
  // import('…')
  /\bimport\s*\(\s*(['"])([^'"\n]+)\1\s*\)/g,
];

const lineOf = (source: string, index: number): number => source.slice(0, index).split('\n').length;

interface SourceFile {
  // Relative to packages/, such as core/src/index.ts
  readonly path: string;
  readonly text: string;
}

interface Violation {
  readonly file: string;
  readonly line: number;
  readonly message: string;
}

const findViolations = (files: readonly SourceFile[]): readonly Violation[] => {
  const violations: Violation[] = [];
  for (const file of files) {
    const [packageName = '', top = '', ...rest] = file.path.split('/');
    const code = blankSource(file.text);
    const add = (index: number, message: string) => violations.push({ file: file.path, line: lineOf(code, index), message });

    for (const pattern of importPatterns) {
      for (const match of code.matchAll(pattern)) {
        const specifier = match[2]!;
        const index = match.index + match[0].indexOf(specifier);
        const internal = /^@servicerouter\/([^/]+)/.exec(specifier)?.[1];
        if (internal === 'testing' && packageName !== 'testing')
          add(index, `imports ${specifier}: only test code may import @servicerouter/testing`);
        else if (internal !== undefined && internal !== packageName && allowedImports[packageName] && !allowedImports[packageName].includes(internal))
          add(index, `imports ${specifier}: ${packageName} may import ${allowedImports[packageName].map(name => `@servicerouter/${name}`).join(', ') || 'no internal package'}`);
        else if (packageName === 'payments' && frameworkImport.test(specifier))
          add(index, `imports ${specifier}: payments knows no HTTP framework or database (PR-11)`);
        else if (specifier.startsWith('.')) {
          const target = path.posix.join(top, path.posix.dirname(rest.join('/')), specifier);
          if (!sourceDirectories.some(directory => target.startsWith(`${directory}/`)))
            add(index, `imports ${specifier}: reaches outside ${packageName}/${top}. Import the package instead`);
        }
      }
    }

    if (domainPackages.includes(packageName)) {
      const codeOnly = blankSource(file.text, { literals: true });
      for (const [pattern, call] of bannedCalls) {
        for (const match of codeOnly.matchAll(pattern))
          add(match.index, `calls ${call}: domain code takes the Clock and IdGenerator ports (CK-5)`);
      }
    }
  }

  return violations;
};

const readSources = async (): Promise<readonly SourceFile[]> => {
  const packages = (await readdir(packagesRoot, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name);
  const paths = (await Promise.all(packages.flatMap(name => sourceDirectories.map(async directory => {
    const entries = await readdir(path.join(packagesRoot, name, directory), { recursive: true, withFileTypes: true }).catch(() => []);

    return entries
      .filter(entry => entry.isFile() && /\.tsx?$/.test(entry.name))
      .map(entry => path.relative(packagesRoot, path.join(entry.parentPath, entry.name)).split(path.sep).join('/'));
  })))).flat();

  return Promise.all(paths.map(async file => ({ path: file, text: await readFile(path.join(packagesRoot, file), 'utf8') })));
};

const format = (violations: readonly Violation[]): readonly string[] =>
  violations.map(violation => `${violation.file}:${violation.line} ${violation.message}`);

describe('architecture rules', () => {
  let sources: readonly SourceFile[];

  beforeAll(async () => {
    sources = await readSources();
  });

  it('reads every package', () => {
    const packages = new Set(sources.map(file => file.path.split('/')[0]));

    expect([...packages].sort()).toEqual(['api', 'common', 'core', 'db', 'payments', 'proxy', 'signer', 'testing', 'web', 'workers']);
  });

  it('keeps every import within the dependency rules of section 1.4, and testing out of src', () => {
    expect(format(findViolations(sources).filter(violation => violation.message.startsWith('imports')))).toEqual([]);
  });

  it('keeps Date.now(), new Date(), Math.random(), and randomUUID() out of core and payments (CK-5)', () => {
    expect(format(findViolations(sources).filter(violation => violation.message.startsWith('calls')))).toEqual([]);
  });

  describe('catches', () => {
    const check = (filePath: string, text: string) => format(findViolations([{ path: filePath, text }]));

    it.each([
      ['common', 'common/src/a.ts', 'import { x } from \'@servicerouter/core\';'],
      ['core', 'core/src/a.ts', 'export { x } from "@servicerouter/db";'],
      ['db', 'db/src/a.ts', 'import type { X } from \'@servicerouter/payments\';'],
      ['payments', 'payments/src/a.ts', 'import {\n  x,\n} from \'@servicerouter/db\';'],
      ['signer', 'signer/src/a.ts', 'const core = await import(\'@servicerouter/core\');'],
    ])('a forbidden import in %s', (_name, filePath, text) => {
      expect(check(filePath, text)).toEqual([expect.stringMatching(/ imports @servicerouter\/\w+: /)]);
    });

    it.each([
      ['Fastify', 'import type { FastifyRequest } from \'fastify\';'],
      ['Drizzle', 'import { eq } from \'drizzle-orm\';'],
      ['an mppx framework adapter', 'import { Mppx } from \'mppx/hono\';'],
    ])('%s in payments (PR-11)', (_name, text) => {
      expect(check('payments/src/mpp/a.ts', text)).toEqual([expect.stringMatching(/^payments\/src\/mpp\/a\.ts:1 imports .+: payments knows no HTTP framework or database \(PR-11\)$/)]);
    });

    it('nothing in payments\' use of mppx\'s core and Tempo modules (PR-11)', () => {
      expect(check('payments/src/mpp/a.ts', 'import { Challenge } from \'mppx\';\nimport { Mppx, tempo } from \'mppx/server\';\nimport { Transaction } from \'viem/tempo\';')).toEqual([]);
    });

    it('an import of a package of ours in the website, which reads only the Platform API (WB-2)', () => {
      expect(check('web/app/page.tsx', 'import { parseUsd } from \'@servicerouter/common\';'))
        .toEqual(['web/app/page.tsx:1 imports @servicerouter/common: web may import no internal package']);
      expect(check('web/app/discover/page.tsx', 'import { readSettings } from \'../../src/config\';')).toEqual([]);
    });

    it('an import of @servicerouter/testing from any src', () => {
      expect(check('proxy/src/main.ts', 'import { startFakeUpstream } from \'@servicerouter/testing\';'))
        .toEqual(['proxy/src/main.ts:1 imports @servicerouter/testing: only test code may import @servicerouter/testing']);
    });

    it('a relative import into another package', () => {
      expect(check('core/src/service/a.ts', 'import { x } from \'../../../db/src/index.js\';'))
        .toEqual(['core/src/service/a.ts:1 imports ../../../db/src/index.js: reaches outside core/src. Import the package instead']);
    });

    it.each([
      ['Date.now()', 'const at = Date.now();'],
      ['new Date()', 'const at = new Date();'],
      ['new Date', 'const at = new Date;'],
      ['Date()', 'const at = Date();'],
      ['Math.random()', 'const id = Math.random().toString(36);'],
      ['randomUUID()', 'import { randomUUID } from \'node:crypto\';\nconst id = randomUUID();'],
      ['crypto.randomUUID()', 'const id = crypto.randomUUID();'],
    ])('%s in domain code (CK-5)', (_name, text) => {
      expect(check('payments/src/a.ts', text)).toEqual([expect.stringMatching(/^payments\/src\/a\.ts:\d+ calls .+ \(CK-5\)$/)]);
    });

    it('nothing in allowed code (CK-5)', () => {
      const text = [
        'import { randomBytes } from \'node:crypto\';',
        '// Never Date.now() here: take a Clock',
        '/* new Date() and Math.random() */',
        'const at = new Date(clock.now());',
        'const parsed = new Date(\'2026-10-06T19:50:00+08:00\');',
        'const nonce = randomBytes(32);',
        'const pattern = /\\/\\/ Date.now()/;',
        'const url = `https://${host}/path?at=${clock.now().getTime() / 1000}`;',
        'const ratio = total / count; // Math.random()',
      ].join('\n');

      expect(check('core/src/a.ts', text)).toEqual([]);
      expect(check('common/src/ports.ts', 'export const systemClock = { now: () => new Date() };')).toEqual([]);
    });
  });
});

describe('blankSource', () => {
  const source = [
    'const a = \'// not a comment\'; // a comment',
    'const b = `${x /* inside */}//${`nested ${y}`}`; /* block',
    'comment */ const c = /[/]\\/*/.test(d) / 2;',
  ].join('\n');

  it('blanks comments and keeps strings, templates, regular expressions, and line breaks', () => {
    expect(blankSource(source).split('\n')).toEqual([
      `const a = '// not a comment';${' '.repeat(13)}`,
      `const b = \`\${x${' '.repeat(13)}}//\${\`nested \${y}\`}\`;${' '.repeat(9)}`,
      `${' '.repeat(11)}const c = /[/]\\/*/.test(d) / 2;`,
    ]);
  });

  it('blanks the contents of literals too, keeping the code inside a template', () => {
    expect(blankSource(source, { literals: true }).split('\n')).toEqual([
      `const a = '${' '.repeat(16)}';${' '.repeat(13)}`,
      `const b = \`\${x${' '.repeat(13)}}  \${\`       \${y}\`}\`;${' '.repeat(9)}`,
      `${' '.repeat(11)}const c = /${' '.repeat(6)}/.test(d) / 2;`,
    ]);
  });
});
