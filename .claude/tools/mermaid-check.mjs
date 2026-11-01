#!/usr/bin/env node
// Checks Mermaid diagrams in Markdown the way GitHub will show them.
//
//   node .claude/tools/mermaid-check.mjs [files or folders…] [--out DIR] [--no-render] [--json]
//
// For every ```mermaid block it reports: the natural size of the rendered SVG, how much GitHub
// shrinks it to fit the ~880 px content column (text under 75% is hard to read), and static
// lint findings (left-to-right flowcharts, long labels, crowded diagrams, syntax GitHub mangles).
// PNGs at GitHub width are written to --out so a reviewer can look at them.
//
// Rendering uses @mermaid-js/mermaid-cli with a browser that is already installed (Chrome,
// Chromium, Edge or Brave). The CLI is installed once into ~/.cache/pulse-mermaid, outside the
// repo, without install scripts and without downloading a browser. Exit code 1 = errors found.

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, join, relative, resolve } from 'node:path';

const GITHUB_WIDTH = 880;
const MIN_SCALE = 0.75;
const MAX_HEIGHT = 1600;
const LIMITS = {
  nodeLine: 28,
  edgeLabel: 20,
  message: 48,
  participants: 5,
  nodes: 14,
  erRelations: 10,
};

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const outDir = resolve(option('--out') ?? join(tmpdir(), 'pulse-mermaid-check'));
const targets = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--out');
if (targets.length === 0) targets.push('docs');

function markdownFiles(path) {
  const stat = statSync(path);
  if (stat.isFile()) return path.endsWith('.md') ? [path] : [];
  return readdirSync(path)
    .filter((name) => name !== 'node_modules' && !name.startsWith('.'))
    .flatMap((name) => markdownFiles(join(path, name)));
}

function extractBlocks(file) {
  const lines = readFileSync(file, 'utf8').split('\n');
  const blocks = [];
  let body = null;
  let start = 0;
  lines.forEach((line, i) => {
    if (body === null && line.trim() === '```mermaid') {
      body = [];
      start = i + 2;
    } else if (body !== null && line.trim() === '```') {
      blocks.push({ file, line: start, source: body.join('\n') });
      body = null;
    } else if (body !== null) {
      body.push(line);
    }
  });
  return blocks;
}

function kindOf(source) {
  const first = source.split('\n').find((l) => l.trim() && !l.trim().startsWith('%%')) ?? '';
  return first.trim().split(/\s+/)[0];
}

// Text a reader sees inside a node: [..], (..), {..}, [[..]], [(..)], ((..)), quotes removed
function nodeLabels(line) {
  const found = [];
  const re = /[A-Za-z0-9_]+\s*(\[\[|\[\(|\(\(|\[|\(|\{)(.*?)(\]\]|\)\]|\)\)|\]|\)|\})/g;
  for (const m of line.matchAll(re)) found.push(m[2].replace(/^"|"$/g, ''));
  return found;
}

function edgeLabels(line) {
  const found = [];
  for (const m of line.matchAll(/\|([^|]+)\|/g)) found.push(m[1]);
  for (const m of line.matchAll(/--\s+([^->|][^>]*?)\s+--[->]/g)) found.push(m[1]);
  return found;
}

const visibleLines = (label) =>
  label.split(/<br\s*\/?>/i).map((s) => s.replace(/<[^>]+>/g, '').trim());

function lint(block) {
  const findings = [];
  const add = (level, rule, message) => findings.push({ level, rule, message });
  const kind = kindOf(block.source);
  const lines = block.source.split('\n');

  if (kind === 'flowchart' || kind === 'graph') {
    const dir = block.source.trim().split(/\s+/)[1];
    if (dir === 'LR' || dir === 'RL')
      add('warn', 'direction', `flowchart ${dir}: GitHub pages are narrow, prefer TB`);
    const ids = new Set();
    for (const line of lines) {
      if (
        /^\s*(flowchart|graph|subgraph|end|classDef|class|style|linkStyle|%%|direction)\b/.test(
          line,
        )
      )
        continue;
      // Drop labels first, so words inside them ("wait-or-go") are not counted as node ids
      const bare = line
        .replace(/"[^"]*"/g, '')
        .replace(/\[[^\]]*\]|\([^)]*\)|\{[^}]*\}|\|[^|]*\|/g, '')
        .replace(/[-.=~<>ox]*[-.=]{2,}[-.=~<>ox]*/g, ' ');
      for (const m of bare.matchAll(/\b([A-Za-z][A-Za-z0-9_]*)\b/g)) ids.add(m[1]);
      for (const label of nodeLabels(line)) {
        for (const text of visibleLines(label)) {
          if (text.length > LIMITS.nodeLine)
            add(
              'warn',
              'node-label',
              `"${text}" is ${text.length} chars (max ${LIMITS.nodeLine} per line; use <br/>)`,
            );
        }
        if (/^\s*\d+[a-z]?\.\s/.test(label))
          add(
            'error',
            'list-label',
            `"${label.slice(0, 30)}…" starts like a list; GitHub shows "Unsupported markdown: list"`,
          );
      }
      for (const label of edgeLabels(line)) {
        const longest = Math.max(...visibleLines(label).map((t) => t.length));
        if (longest > LIMITS.edgeLabel)
          add(
            'warn',
            'edge-label',
            `edge label "${label}" has a ${longest}-char line (max ${LIMITS.edgeLabel})`,
          );
      }
    }
    if (ids.size > LIMITS.nodes)
      add(
        'warn',
        'crowded',
        `about ${ids.size} nodes (max ${LIMITS.nodes}); split into two diagrams`,
      );
  }

  if (kind === 'sequenceDiagram') {
    const people = new Set();
    for (const line of lines) {
      const p = line.match(/^\s*(participant|actor)\s+(\S+)/);
      if (p) people.add(p[2]);
      const msg = line.match(
        /^\s*([A-Za-z0-9_]+)\s*(-->>|->>|-->|->|--x|-x|--\)|-\))\s*([A-Za-z0-9_]+)\s*:(.*)$/,
      );
      if (msg) {
        people.add(msg[1]);
        people.add(msg[3]);
        const text = msg[4].trim();
        const longest = Math.max(...visibleLines(text).map((t) => t.length));
        if (longest > LIMITS.message)
          add(
            'warn',
            'message',
            `"${text.slice(0, 40)}…" is ${longest} chars (max ${LIMITS.message}); move detail into a Note or the text`,
          );
        if (text.includes(';'))
          add(
            'error',
            'semicolon',
            `";" in a message ends the statement early: "${text.slice(0, 40)}…"`,
          );
      }
    }
    if (people.size > LIMITS.participants)
      add(
        'warn',
        'participants',
        `${people.size} participants (max ${LIMITS.participants}); merge or split`,
      );
  }

  if (kind === 'erDiagram') {
    const relations = lines.filter((l) => /[|}o][|o]--|\.\./.test(l)).length;
    if (relations > LIMITS.erRelations)
      add(
        'warn',
        'crowded',
        `${relations} relationships (max ${LIMITS.erRelations}); split by domain`,
      );
  }

  if (kind === 'journey')
    add(
      'warn',
      'journey',
      'journey diagrams only grow sideways; use a TB flowchart for long journeys',
    );
  return findings;
}

const BROWSERS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
];

function prepareRenderer() {
  const browser = process.env.PUPPETEER_EXECUTABLE_PATH ?? BROWSERS.find((b) => existsSync(b));
  if (!browser)
    return { reason: 'no Chrome, Chromium, Edge or Brave found (set PUPPETEER_EXECUTABLE_PATH)' };
  const cache = join(process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'pulse-mermaid');
  const mmdc = join(cache, 'node_modules', '.bin', 'mmdc');
  if (!existsSync(mmdc)) {
    mkdirSync(cache, { recursive: true });
    if (!existsSync(join(cache, 'package.json')))
      writeFileSync(join(cache, 'package.json'), '{"private":true}\n');
    console.error(`Installing mermaid-cli into ${cache} (once)…`);
    execFileSync(
      'npm',
      [
        'install',
        '--no-audit',
        '--no-fund',
        '--ignore-scripts',
        '@mermaid-js/mermaid-cli@11',
        'puppeteer',
      ],
      {
        cwd: cache,
        env: { ...process.env, PUPPETEER_SKIP_DOWNLOAD: 'true' },
        stdio: ['ignore', 'ignore', 'inherit'],
      },
    );
  }
  const config = join(cache, 'puppeteer.json');
  writeFileSync(
    config,
    JSON.stringify({ executablePath: browser, headless: 'new', args: ['--no-sandbox'] }),
  );
  return { mmdc, config };
}

function render(renderer, block, name) {
  const input = join(outDir, `${name}.mmd`);
  writeFileSync(input, block.source + '\n');
  const run = (output, extra) =>
    spawnSync(
      renderer.mmdc,
      ['-q', '-p', renderer.config, '-i', input, '-o', output, '-b', 'white', ...extra],
      { encoding: 'utf8' },
    );
  const svgPath = join(outDir, `${name}.svg`);
  const svg = run(svgPath, []);
  if (svg.status !== 0) {
    const reason = (svg.stderr.match(/(Error|Parse error)[^\n]*/) ?? ['render failed'])[0];
    return { error: reason.slice(0, 160) };
  }
  const box = readFileSync(svgPath, 'utf8').match(/viewBox="[-\d.]+ [-\d.]+ ([\d.]+) ([\d.]+)"/);
  const width = box ? Math.round(Number(box[1])) : 0;
  const height = box ? Math.round(Number(box[2])) : 0;
  const pngPath = join(outDir, `${name}.png`);
  run(pngPath, ['-w', String(GITHUB_WIDTH), '-s', '1']);
  return { width, height, png: pngPath };
}

mkdirSync(outDir, { recursive: true });
const blocks = targets.flatMap(markdownFiles).flatMap(extractBlocks);
let renderer = null;
if (!flag('--no-render') && blocks.length > 0) {
  renderer = prepareRenderer();
  if (renderer.reason) {
    console.error(`Rendering skipped: ${renderer.reason}. Static checks only.`);
    renderer = null;
  }
}

const results = blocks.map((block, index) => {
  const where = `${relative(process.cwd(), block.file)}:${block.line}`;
  const name = `${String(index + 1).padStart(3, '0')}-${basename(block.file, '.md')}-L${block.line}`;
  const findings = lint(block);
  let size = null;
  if (renderer) {
    size = render(renderer, block, name);
    if (size.error) findings.push({ level: 'error', rule: 'render', message: size.error });
    else {
      const scale = Math.min(1, GITHUB_WIDTH / size.width);
      size.scale = Number(scale.toFixed(2));
      if (scale < MIN_SCALE)
        findings.push({
          level: 'error',
          rule: 'too-wide',
          message: `${size.width} px wide → shown at ${Math.round(scale * 100)}% on GitHub (min ${MIN_SCALE * 100}%)`,
        });
      if (size.height * scale > MAX_HEIGHT)
        findings.push({
          level: 'warn',
          rule: 'too-tall',
          message: `${Math.round(size.height * scale)} px tall on GitHub; consider splitting`,
        });
    }
  }
  return { where, kind: kindOf(block.source), size, findings };
});

if (flag('--json')) {
  console.log(JSON.stringify({ outDir, results }, null, 2));
} else {
  console.log(`| Diagram | Kind | Natural size | On GitHub | Errors | Warnings |`);
  console.log(`| --- | --- | --- | --- | --- | --- |`);
  for (const r of results) {
    const size = r.size && !r.size.error ? `${r.size.width}×${r.size.height}` : '–';
    const shown = r.size?.scale ? `${Math.round(r.size.scale * 100)}%` : '–';
    const errors = r.findings.filter((f) => f.level === 'error').length;
    const warns = r.findings.filter((f) => f.level === 'warn').length;
    console.log(`| ${r.where} | ${r.kind} | ${size} | ${shown} | ${errors} | ${warns} |`);
  }
  console.log('');
  for (const r of results.filter((x) => x.findings.length > 0)) {
    console.log(`${r.where}`);
    for (const f of r.findings)
      console.log(`  ${f.level === 'error' ? '✖' : '⚠'} ${f.rule}: ${f.message}`);
  }
  console.log(`\nPNGs (GitHub width ${GITHUB_WIDTH}px): ${outDir}`);
}
process.exit(results.some((r) => r.findings.some((f) => f.level === 'error')) ? 1 : 0);
