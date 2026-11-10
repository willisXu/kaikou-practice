#!/usr/bin/env node
// 架構檢查：強制 team/architecture.rules.json 的分層邊界與禁用寫法。
// 支援 JavaScript／TypeScript／HTML 的 import，以及 Python 的 import。
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_EXTENSIONS = ['.mjs', '.cjs', '.js', '.jsx', '.ts', '.tsx', '.py', '.html'];
const DEFAULT_EXCLUDE = ['node_modules', '.git', '.venv', 'venv', '__pycache__', 'dist', 'build'];
const JS_IMPORT =
  /\bfrom\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)|\bimport\s+['"]([^'"]+)['"]|\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
const PY_IMPORT = /^[ \t]*(?:from[ \t]+([\w.]+)[ \t]+import\b|import[ \t]+([^\n#;]+))/gm;

const toPosix = (path) => path.split(sep).join('/');

function matches(rel, pattern) {
  return pattern.endsWith('/') ? rel.startsWith(pattern) : rel === pattern;
}

function matchesAny(rel, patterns) {
  return [patterns].flat().some((pattern) => matches(rel, pattern));
}

function listFiles(root, entry, rules) {
  const abs = join(root, entry);
  if (!existsSync(abs)) return [];
  const rel = toPosix(relative(root, abs));
  const excluded = (path) =>
    rules.exclude.some((item) => (item.includes('/') ? matches(path, item) || path === item.replace(/\/$/, '') : path.split('/').includes(item)));

  if (rel && excluded(rel)) return [];
  if (statSync(abs).isFile()) return rules.extensions.includes(extname(abs)) ? [rel] : [];
  return readdirSync(abs).flatMap((name) => listFiles(root, rel ? `${rel}/${name}` : name, rules));
}

function importTargets(root, file, source) {
  if (file.endsWith('.py')) {
    return [...source.matchAll(PY_IMPORT)].flatMap((match) => {
      const names = match[1] ? [match[1]] : match[2].split(',').map((part) => part.trim().split(/\s+/)[0]);
      return names.filter((name) => name && !name.startsWith('.')).map((name) => ({ spec: name, target: name }));
    });
  }
  return [...source.matchAll(JS_IMPORT)].map((match) => {
    const spec = match[1] ?? match[2] ?? match[3] ?? match[4];
    const target = spec.startsWith('.')
      ? toPosix(relative(root, resolve(root, dirname(file), spec)))
      : spec.replace(/^node:/, '');
    return { spec, target };
  });
}

function isBanned(file, target, banned) {
  if (file.endsWith('.py')) return target === banned || target.startsWith(`${banned}.`);
  const name = banned.replace(/^node:/, '');
  if (name.endsWith('/')) return target.startsWith(name);
  return target === name || target.startsWith(`${name}/`);
}

export function findViolations(root, config) {
  const rules = {
    extensions: config.extensions ?? DEFAULT_EXTENSIONS,
    exclude: [...DEFAULT_EXCLUDE, ...(config.exclude ?? [])],
    scan: config.scan ?? ['.'],
    boundaries: config.boundaries ?? [],
    bannedPatterns: config.bannedPatterns ?? [],
  };
  const files = [...new Set(rules.scan.flatMap((entry) => listFiles(root, entry, rules)))];
  const violations = [];

  for (const file of files) {
    const source = readFileSync(join(root, file), 'utf8');

    for (const boundary of rules.boundaries) {
      if (!matchesAny(file, boundary.files)) continue;
      for (const { spec, target } of importTargets(root, file, source)) {
        if (boundary.mustNotImport.some((banned) => isBanned(file, target, banned))) {
          violations.push(`${file}：不可 import "${spec}"。${boundary.why}`);
        }
      }
    }

    const lines = source.split('\n');
    for (const rule of rules.bannedPatterns) {
      if (rule.files && !matchesAny(file, rule.files)) continue;
      const pattern = new RegExp(rule.pattern);
      lines.forEach((line, index) => {
        if (pattern.test(line)) violations.push(`${file}:${index + 1}：命中禁用寫法 /${rule.pattern}/。${rule.why}`);
      });
    }
  }

  return { files: files.length, boundaries: rules.boundaries.length, patterns: rules.bannedPatterns.length, violations };
}

function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const config = JSON.parse(readFileSync(join(root, 'team/architecture.rules.json'), 'utf8'));
  const result = findViolations(root, config);

  if (result.violations.length > 0) {
    console.error(`架構檢查失敗（${result.violations.length} 項）：`);
    for (const violation of result.violations) console.error(`  - ${violation}`);
    console.error('\n規則在 team/architecture.rules.json。請修程式碼，不要放寬規則；規則本身有誤，先記到 team/corrections.md。');
    process.exit(1);
  }

  console.log(`架構檢查通過：${result.files} 個檔案、${result.boundaries} 條邊界、${result.patterns} 條禁用寫法。`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
