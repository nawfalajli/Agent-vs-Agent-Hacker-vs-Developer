import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyReferee } from '../src/jev.js';

const finding = { id: 'x', title: 't', cwe: 'CWE-1', severity: 'high', location: 'a.js:1', summary: 's', proofIdea: 'i' };

test('accepts a confident, real, in-scope, non-duplicate finding', () => {
  const r = applyReferee(finding, { real: 0.95, inScope: 0.95, severity: 'high', severityConfidence: 0.9, duplicate: 0.0, confidence: 0.95 }, 0.7);
  assert.equal(r.action, 'accept');
});

test('low confidence routes to needs-triage', () => {
  const r = applyReferee(finding, { real: 0.9, inScope: 0.9, severity: 'high', severityConfidence: 0.9, duplicate: 0, confidence: 0.4 }, 0.7);
  assert.equal(r.action, 'needs-triage');
});

test('duplicate is dismissed', () => {
  const r = applyReferee(finding, { real: 0.9, inScope: 0.9, severity: 'high', severityConfidence: 0.9, duplicate: 0.8, confidence: 0.9 }, 0.7);
  assert.equal(r.action, 'dismissed');
});

test('not-real or out-of-scope is dismissed', () => {
  assert.equal(applyReferee(finding, { real: 0.2, inScope: 0.9, severity: 'high', severityConfidence: 0.9, duplicate: 0, confidence: 0.9 }, 0.7).action, 'dismissed');
  assert.equal(applyReferee(finding, { real: 0.9, inScope: 0.1, severity: 'high', severityConfidence: 0.9, duplicate: 0, confidence: 0.9 }, 0.7).action, 'dismissed');
});

test('Jev can correct severity when confident, else keeps the Hacker call', () => {
  const up = applyReferee(finding, { real: 0.9, inScope: 0.9, severity: 'critical', severityConfidence: 0.9, duplicate: 0, confidence: 0.9 }, 0.7);
  assert.equal(up.finding.severity, 'critical');
  const keep = applyReferee(finding, { real: 0.9, inScope: 0.9, severity: 'low', severityConfidence: 0.3, duplicate: 0, confidence: 0.9 }, 0.7);
  assert.equal(keep.finding.severity, 'high'); // low confidence on severity -> keep original
});
