import { test } from 'node:test';
import assert from 'node:assert/strict';
import { UserError } from '../src/types';
import { envToken, isSameOrganizationUrl, normalizeOrganization, organizationIdentity, parseOrganizationInput, parseWorkItemInput, resolveToken, validateDirectory, validateId, validateProject } from '../src/validation';

const connection = { organizationUrl: 'https://dev.azure.com/example', project: 'My Project' };

test('normalizes Azure cloud organization and legacy URL', () => {
  assert.equal(normalizeOrganization('https://dev.azure.com/Example/'), connection.organizationUrl);
  assert.equal(normalizeOrganization('https://Example.visualstudio.com/'), 'https://example.visualstudio.com');
});

test('accepts vffice root and screenshot project URL without rewriting the host', () => {
  assert.deepEqual(parseOrganizationInput('https://vffice.visualstudio.com/'),
    { organizationUrl: 'https://vffice.visualstudio.com' });
  assert.deepEqual(parseOrganizationInput('https://vffice.visualstudio.com/VFF070.Pro-Demnity'),
    { organizationUrl: 'https://vffice.visualstudio.com', project: 'VFF070.Pro-Demnity' });
});

test('extracts and decodes project names from both organization URL forms', () => {
  for (const root of ['https://example.visualstudio.com', 'https://dev.azure.com/example']) {
    assert.deepEqual(parseOrganizationInput(root + '/My%20Project/'),
      { organizationUrl: root, project: 'My Project' });
    assert.deepEqual(parseOrganizationInput(root + '/%E6%B5%8B%E8%AF%95'),
      { organizationUrl: root, project: '测试' });
    assert.deepEqual(parseOrganizationInput(root + '/'), { organizationUrl: root });
  }
});

test('organization input still rejects unsafe URLs and nested page routes', () => {
  for (const input of [
    'https://vffice.visualstudio.com.evil.test/Project',
    'http://vffice.visualstudio.com/Project',
    'https://user:secret@vffice.visualstudio.com/Project',
    'https://vffice.visualstudio.com/Project?token=secret',
    'https://vffice.visualstudio.com/Project/_git/repo',
    'https://vffice.visualstudio.com/%GG',
    'https://vffice.visualstudio.com/Project%2fOther',
    'https://vffice.visualstudio.com//Project',
    'https://ado.internal/collection',
  ]) { assert.throws(() => parseOrganizationInput(input), input); }
});

test('both endpoint forms share the existing canonical credential identity', () => {
  assert.equal(organizationIdentity('https://vffice.visualstudio.com/'), 'https://dev.azure.com/vffice');
  assert.equal(organizationIdentity('https://dev.azure.com/vffice'), 'https://dev.azure.com/vffice');
});

test('a visualstudio connection accepts same-organization links using either alias', () => {
  const legacy = { organizationUrl: 'https://vffice.visualstudio.com', project: 'VFF070.Pro-Demnity' };
  for (const root of ['https://vffice.visualstudio.com', 'https://dev.azure.com/vffice']) {
    assert.equal(parseWorkItemInput(root + '/VFF070.Pro-Demnity/_workitems/edit/21835', legacy), 21835);
  }
  assert.throws(() => parseWorkItemInput('https://other.visualstudio.com/VFF070.Pro-Demnity/_workitems/edit/21835', legacy));
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

test('envToken reads and trims AZURE_DEVOPS_PAT and ignores empty values', () => {
  assert.equal(envToken({}), undefined);
  assert.equal(envToken({ AZURE_DEVOPS_PAT: '   ' }), undefined);
  assert.equal(envToken({ AZURE_DEVOPS_PAT: '  env-pat-token  ' }), 'env-pat-token');
});

test('resolveToken falls back to AZURE_DEVOPS_PAT when stored token is missing or blank', () => {
  assert.equal(resolveToken(undefined, { AZURE_DEVOPS_PAT: '  env-pat  ' }), 'env-pat');
  assert.equal(resolveToken('   ', { AZURE_DEVOPS_PAT: 'env-pat' }), 'env-pat');
});

test('resolveToken prefers non-empty stored token over AZURE_DEVOPS_PAT', () => {
  assert.equal(resolveToken('  stored-pat  ', { AZURE_DEVOPS_PAT: 'env-pat' }), 'stored-pat');
});

test('resolveToken throws UserError when neither stored token nor AZURE_DEVOPS_PAT is available', () => {
  for (const stored of [undefined, '', '   ']) {
    for (const env of [{}, { AZURE_DEVOPS_PAT: '' }, { AZURE_DEVOPS_PAT: ' \t ' }]) {
      assert.throws(() => resolveToken(stored, env),
        (error: unknown) => error instanceof UserError && /AZURE_DEVOPS_PAT/.test(error.message));
    }
  }
});

test('isSameOrganizationUrl matches across visualstudio.com and dev.azure.com aliases only', () => {
  const legacyOrg = 'https://vffice.visualstudio.com';
  const modernOrg = 'https://dev.azure.com/vffice';
  for (const imageUrl of [
    'https://vffice.visualstudio.com/Proj/_apis/wit/attachments/1234',
    'https://dev.azure.com/vffice/Proj/_apis/wit/attachments/1234',
  ]) {
    assert.equal(isSameOrganizationUrl(imageUrl, legacyOrg), true);
    assert.equal(isSameOrganizationUrl(imageUrl, modernOrg), true);
  }
  for (const otherUrl of [
    'https://other.visualstudio.com/Proj/_apis/wit/attachments/1234',
    'https://dev.azure.com/other/Proj/_apis/wit/attachments/1234',
    'https://cdn.example.com/image.png',
    'http://vffice.visualstudio.com/_apis/wit/attachments/1234',
    'https://user:pass@vffice.visualstudio.com/_apis/wit/attachments/1234',
    'https://vffice.visualstudio.com:8443/_apis/wit/attachments/1234',
    'not-a-url',
  ]) {
    assert.equal(isSameOrganizationUrl(otherUrl, legacyOrg), false);
    assert.equal(isSameOrganizationUrl(otherUrl, modernOrg), false);
  }
});
