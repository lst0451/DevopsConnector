import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeOrganization, parseWorkItemInput, validateDirectory, validateId, validateProject } from '../src/validation';

const connection = { organizationUrl: 'https://dev.azure.com/example', project: 'My Project' };

test('normalizes Azure cloud organization and legacy URL', () => {
  assert.equal(normalizeOrganization('https://dev.azure.com/Example/'), connection.organizationUrl);
  assert.equal(normalizeOrganization('https://Example.visualstudio.com/'), connection.organizationUrl);
});

test('rejects non-Azure hosts, credentials, HTTP and organization paths', () => {
  for (const input of ['http://dev.azure.com/example', 'https://dev.azure.com.evil.test/example',
    'https://user:secret@dev.azure.com/example', 'https://dev.azure.com/example/other',
    'https://dev.azure.com/example?token=x', 'https://ado.internal/collection']) {
    assert.throws(() => normalizeOrganization(input));
  }
});

test('validates project and numeric ID', () => {
  assert.equal(validateProject(' My Project '), 'My Project');
  assert.equal(validateId('21835'), 21835);
  for (const id of ['0', '-1', '1.2', '1e3', '001', '2147483648']) {
    assert.throws(() => validateId(id));
  }
  assert.throws(() => validateProject('..'));
});

test('parses ID and canonical/legacy work item links', () => {
  assert.equal(parseWorkItemInput(' 21835 ', connection), 21835);
  assert.equal(parseWorkItemInput('https://dev.azure.com/example/My%20Project/_workitems/edit/21835', connection), 21835);
  assert.equal(parseWorkItemInput('https://example.visualstudio.com/My%20Project/_workitems/edit/21835', connection), 21835);
});

test('does not silently switch organization or project from a pasted URL', () => {
  for (const url of [
    'https://dev.azure.com/other/My%20Project/_workitems/edit/21835',
    'https://dev.azure.com/example/Other/_workitems/edit/21835',
    'https://dev.azure.com/example/My%20Project/_git/repo',
    'https://dev.azure.com/example/%GG/_workitems/edit/21835',
    'https://evil.test/example/My%20Project/_workitems/edit/21835',
  ]) { assert.throws(() => parseWorkItemInput(url, connection)); }
});

test('validates portable relative output directories', () => {
  assert.deepEqual(validateDirectory('docs\\workitems'), ['docs', 'workitems']);
  assert.deepEqual(validateDirectory('.vscode/spec'), ['.vscode', 'spec']);
  for (const value of ['', '/', '../outside', 'docs/../../outside', 'C:\\temp',
    '\\\\server\\share', 'docs//items', '.git/items', 'node_modules/items',
    'docs/nul.txt', 'docs/a.', 'docs/a:stream', 'docs/CON', 'docs/../items']) {
    assert.throws(() => validateDirectory(value), value);
  }
});
