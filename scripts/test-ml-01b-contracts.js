const assert = require('node:assert/strict');
const { parseFillDirection, parseFillMode } = require('../out/fill-prompt.js');
const { ExternalFileConflictError, isExternalFileConflictError } = require('../out/user-errors.js');
const { refreshStructureCapabilityAfterSave } = require('../out/structure-capability.js');

for (const value of ['down', ' DOWN ', 'abajo', 'Abajo']) {assert.equal(parseFillDirection(value), 'down');}
for (const value of ['right', ' DERECHA ']) {assert.equal(parseFillDirection(value), 'right');}
for (const value of ['repeat', ' REPETIR ']) {assert.equal(parseFillMode(value), 'repeat');}
for (const value of ['series', ' SERIE ']) {assert.equal(parseFillMode(value), 'series');}
for (const value of [undefined, null, '', 'left']) {assert.equal(parseFillDirection(value), undefined);}
for (const value of [undefined, null, '', 'sequence']) {assert.equal(parseFillMode(value), undefined);}

const conflict = new ExternalFileConflictError('Localized conflict');
assert.equal(conflict.code, 'external-file-conflict');
assert.equal(isExternalFileConflictError(conflict), true);
assert.equal(isExternalFileConflictError(Object.assign(new Error('English'), { code: 'external-file-conflict' })), true);
assert.equal(isExternalFileConflictError(new Error('El archivo cambió en disco')), false);
const pending = { allowed: false, reason: 'Save first', reasonCode: 'pending-changes' };
assert.deepEqual(refreshStructureCapabilityAfterSave(pending, 'saved'), { allowed: true });
assert.deepEqual(refreshStructureCapabilityAfterSave(pending, 'clean'), { allowed: true });
for (const state of ['saving', 'pending', 'error']) {assert.equal(refreshStructureCapabilityAfterSave(pending, state), pending);}
const protectedBook = { allowed: false, reason: 'Protected workbook' };
assert.equal(refreshStructureCapabilityAfterSave(protectedBook, 'saved'), protectedBook, 'save must not rehabilitate other structural blocks');
console.log('Passed: ML-01B stable conflict identity and en/es prompt enums');
