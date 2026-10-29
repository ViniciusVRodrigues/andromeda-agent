import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileServerPatterns, DEFAULT_PATTERNS, taskRefFromBranch } from '../../src/task/patterns.js';
import type { WorkItemPatternsResponse } from '../../src/types.js';

const p = compileServerPatterns(DEFAULT_PATTERNS);

const jira = { regex: '([A-Z][A-Z0-9]{1,9}-\\d+)', preset: 'JIRA_KEY', portable: { source: '([A-Z][A-Z0-9]{1,9}-\\d+)', flags: '' } };
const num = { regex: '(?:^|/)(\\d{2,7})(?=[-_/.]|$)', preset: 'NUMBER', portable: { source: '(?:^|/)(\\d{2,7})(?=[-_/.]|$)', flags: '' } };

test('default do servidor: só AB#<n>', () => {
  const cases: Array<[string, string | null]> = [
    ['feature/AB#1234-login', 'AB#1234'],
    ['feature/ab#99-x', 'AB#99'],
    ['fix/4567-bug-x', null],
    ['feat/PROJ-88_foo', null],
    ['AB#12345x', 'AB#12345'],
    ['main', null],
    ['HEAD', null],
  ];
  for (const [b, e] of cases) assert.equal(taskRefFromBranch(b, p), e, b);
  assert.equal(taskRefFromBranch(null, p), null);
});

test('ordem do servidor é respeitada: Jira antes do número', () => {
  const resp: WorkItemPatternsResponse = { enabled: true, updatedAt: null, patterns: [jira, num] };
  const c = compileServerPatterns(resp);
  assert.equal(taskRefFromBranch('feat/PROJ-88_foo', c), 'PROJ-88');
  assert.equal(taskRefFromBranch('fix/4567-bug', c), '4567');
});

test('portable null, flag estranha ou regex inválida: o servidor decide e o match pula', () => {
  const resp: WorkItemPatternsResponse = {
    enabled: true,
    updatedAt: null,
    patterns: [
      { regex: 'x', preset: 'CUSTOM', portable: null },
      { regex: 'x', preset: 'CUSTOM', portable: { source: '(a\\d+)', flags: 'g' } },
      { regex: 'x', preset: 'CUSTOM', portable: { source: '(a', flags: '' } },
      jira,
    ],
  };
  const c = compileServerPatterns(resp);
  assert.deepEqual(c.map((x) => x.serverOnly), [true, true, true, false]);
  assert.equal(taskRefFromBranch('a12', c), null);
  assert.equal(taskRefFromBranch('feat/PROJ-1', c), 'PROJ-1');
});

test('enabled:false não deixa nenhum padrão local', () => {
  assert.deepEqual(compileServerPatterns({ ...DEFAULT_PATTERNS, enabled: false }), []);
});

test('prefixo AB# só no preset AB_HASH com grupo numérico', () => {
  const c = compileServerPatterns({
    enabled: true,
    updatedAt: null,
    patterns: [{ regex: 'x', preset: 'PREFIX', portable: { source: 'task-(\\d+)', flags: 'i' } }],
  });
  assert.equal(taskRefFromBranch('feat/task-55', c), '55');
});

test('branch é cortada em 255 caracteres', () => {
  const b = 'a'.repeat(260) + '/AB#5';
  assert.equal(taskRefFromBranch(b, p), null);
});
