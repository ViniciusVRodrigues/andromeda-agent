import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compilePatterns, DEFAULT_PATTERNS, taskRefFromBranch } from '../../src/task/patterns.js';

const p = compilePatterns(DEFAULT_PATTERNS);

test('taskRefFromBranch: casos', () => {
  const cases: Array<[string, string | null]> = [
    ['feature/AB#1234-login', 'AB#1234'],
    ['fix/4567-bug-x', '4567'],
    ['bugfix/task-987', '987'],
    ['feat/PROJ-88_foo', 'PROJ-88'],
    ['main', null],
    ['claude/agt1b-prototipo-416f27', null],
    ['HEAD', null],
  ];
  for (const [b, e] of cases) assert.equal(taskRefFromBranch(b, p), e, b);
  assert.equal(taskRefFromBranch(null, p), null);
});

test('compilePatterns: validações', () => {
  assert.throws(() => compilePatterns(['abc', '(x)', 'semgrupo']), /Padrão 0.*grupo/);
  assert.throws(() => compilePatterns(['(a)', 'b+']), /Padrão 1/);
  assert.throws(() => compilePatterns(['(' + 'a'.repeat(200) + ')']), /longo/);
  assert.throws(() => compilePatterns(Array.from({ length: 11 }, () => '(a)')), /demais/);
  assert.throws(() => compilePatterns(['(a']), /inválido/);
});

test('compilePatterns: (?i) vira flag i', () => {
  const [c] = compilePatterns(['(?i)(ticket-\\d+)']);
  assert.equal(taskRefFromBranch('x/TICKET-5', [c!]), 'TICKET-5');
});

test('branch é cortada em 255 caracteres', () => {
  const b = 'a'.repeat(260) + '/AB#5';
  assert.equal(taskRefFromBranch(b, p), null);
});
