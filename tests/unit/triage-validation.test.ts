/**
 * Incident Triage — post-output validation unit tests.
 *
 * What this defends: the boundary between "the model said something" and "the system
 * believes it". These are the checks that make grounding structural rather than a promise,
 * so each rejection path is asserted directly rather than through a provider.
 *
 * Pure calls, no provider, no clock, no network — and no subscription capacity.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_HYPOTHESES, unwrapFencedJson, validateAssessment } from '../../src/modules/triage/validation.ts';

const EVIDENCE = [{ id: 'e1', text: 'first' }, { id: 'e2', text: 'second' }];
const MODULES = ['projects', 'releases'];

const valid = {
  severity: 'SEV-2',
  affectedCapability: 'projects',
  summary: 'Projects are failing to load.',
  hypotheses: ['A bad release'],
  recommendedNextInvestigation: 'Check the last deployment.',
  evidenceRefs: ['e1'],
  confidence: 'medium',
};

function check(body: unknown) {
  return validateAssessment(typeof body === 'string' ? body : JSON.stringify(body), EVIDENCE, MODULES);
}

describe('accepts a well-formed assessment', () => {
  test('returns the normalized assessment', () => {
    const result = check(valid);
    assert.equal(result.ok, true);
    assert.equal(result.ok && result.assessment.severity, 'SEV-2');
  });

  test('accepts "unknown" as a capability, so ambiguity has a legal answer', () => {
    const result = check({ ...valid, affectedCapability: 'unknown' });
    assert.equal(result.ok, true);
  });

  test('accepts an empty evidenceRefs list — citing nothing is honest, citing falsely is not', () => {
    assert.equal(check({ ...valid, evidenceRefs: [] }).ok, true);
  });
});

describe('grounding is enforced structurally', () => {
  test('rejects a citation to evidence that was never supplied', () => {
    const result = check({ ...valid, evidenceRefs: ['e1', 'trace-99999'] });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason, 'ungrounded_evidence');
  });

  test('rejects a capability name that does not exist', () => {
    const result = check({ ...valid, affectedCapability: 'payments' });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason, 'unknown_capability');
  });

  test('distinguishes fabrication from malformation, because they mean different things', () => {
    // A confident answer that invented something is a different failure from a broken one,
    // and the eval thresholds count them separately.
    const fabricated = check({ ...valid, evidenceRefs: ['nope'] });
    const malformed = check({ ...valid, severity: 'CRITICAL' });
    assert.notEqual(
      fabricated.ok === false && fabricated.reason,
      malformed.ok === false && malformed.reason,
    );
  });
});

describe('schema rejections', () => {
  test('rejects non-JSON', () => {
    const result = check('I think it is a caching issue.');
    assert.equal(result.ok === false && result.reason, 'unparseable_output');
  });

  test('rejects JSON that parses but is not an object', () => {
    const result = check('[{"severity":"SEV-2"}]');
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason, 'schema_invalid');
  });

  test('rejects a severity outside the enum rather than coercing it', () => {
    assert.equal(check({ ...valid, severity: 'CRITICAL' }).ok, false);
  });

  test('rejects a missing field rather than defaulting it', () => {
    // A defaulted severity would be an invented judgement presented as the model's.
    const { severity, ...withoutSeverity } = valid;
    assert.equal(check(withoutSeverity).ok, false);
  });

  test('rejects an over-long summary', () => {
    assert.equal(check({ ...valid, summary: 'x'.repeat(601) }).ok, false);
  });

  test('rejects an empty hypothesis list — an assessment must propose something', () => {
    assert.equal(check({ ...valid, hypotheses: [] }).ok, false);
  });

  test('names the offending field in the detail, so a live failure is diagnosable', () => {
    const result = check({ ...valid, summary: 'x'.repeat(601) });
    assert.equal(result.ok, false);
    assert.match(result.ok === false ? result.detail : '', /summary is 601 chars/);
  });
});

describe('hypotheses are truncated, not rejected', () => {
  test('an over-long list is kept and trimmed to the bound', () => {
    // Deliberately different from the grounding checks: extra hypotheses are merely more
    // than the interface wants, not fabrication.
    const result = check({ ...valid, hypotheses: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'] });
    assert.equal(result.ok, true);
    assert.equal(result.ok && result.assessment.hypotheses.length, MAX_HYPOTHESES);
  });

  test('truncation keeps the first entries rather than an arbitrary selection', () => {
    const result = check({ ...valid, hypotheses: ['first', 'b', 'c', 'd', 'e', 'f', 'last'] });
    assert.equal(result.ok && result.assessment.hypotheses[0], 'first');
  });
});

describe('fenced JSON', () => {
  test('unwraps a fenced response, which the real model emits despite instructions', () => {
    assert.equal(unwrapFencedJson('```json\n{"a":1}\n```'), '{"a":1}');
    assert.equal(unwrapFencedJson('```\n{"a":1}\n```'), '{"a":1}');
    assert.equal(unwrapFencedJson('{"a":1}'), '{"a":1}');
  });

  test('validates a fenced assessment end to end', () => {
    assert.equal(check('```json\n' + JSON.stringify(valid) + '\n```').ok, true);
  });

  test('does not salvage JSON buried in prose — partial parsing is how an unvalidated answer escapes', () => {
    assert.equal(check(`Sure! Here you go:\n\n${JSON.stringify(valid)}\n\nHope that helps.`).ok, false);
  });
});
