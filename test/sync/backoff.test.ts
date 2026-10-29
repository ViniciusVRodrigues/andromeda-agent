import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextDelay } from '../../src/sync/backoff.js';

test('backoff: cresce exponencial a partir de 5 s e para em 10 min', () => {
  const max = () => 0.999999;
  assert.equal(nextDelay(1, max), 4999);
  assert.ok(nextDelay(2, max) <= 10_000 && nextDelay(2, max) > 9_000);
  assert.ok(nextDelay(5, max) <= 80_000);
  assert.ok(nextDelay(8, max) <= 600_000);
  assert.ok(nextDelay(8, max) > 500_000);
  assert.ok(nextDelay(50, max) <= 600_000);
});

test('backoff: full jitter vai de 0 ao teto', () => {
  assert.equal(nextDelay(3, () => 0), 0);
  assert.equal(nextDelay(3, () => 0.5), 10_000);
});

test('backoff: Retry-After vence', () => {
  assert.equal(nextDelay(1, () => 0.9, 120), 120_000);
  assert.equal(nextDelay(9, () => 0.9, 0), 0);
  assert.equal(nextDelay(1, () => 0.5, null), 2500);
});
