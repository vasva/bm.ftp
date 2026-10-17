const assert = require('node:assert/strict');
const test = require('node:test');
const { isSafeRemoteName, isSensitiveAgentFilename, resolveGrantedRemotePath, toGrantedRemotePath } = require('../out/mcpPolicy.js');

test('agent FTP paths stay inside the granted root and are presented relative to it', () => {
  assert.equal(resolveGrantedRemotePath('/sites/project', '/src/main.ts'), '/sites/project/src/main.ts');
  assert.equal(resolveGrantedRemotePath('/sites/project', '/'), '/sites/project');
  assert.equal(toGrantedRemotePath('/sites/project', '/sites/project/src/main.ts'), '/src/main.ts');
  assert.equal(toGrantedRemotePath('/sites/project', '/sites/project'), '/');
});

test('agent FTP paths reject traversal outside the granted root and control characters', () => {
  for (const requested of ['/../private', '/src/../../other', '/..', '/safe\\..\\private', '/safe\nNOOP']) {
    assert.throws(() => resolveGrantedRemotePath('/sites/project', requested));
  }
  assert.equal(isSafeRemoteName('../private'), false);
  assert.equal(isSafeRemoteName('folder\\..\\private'), false);
  assert.equal(isSafeRemoteName('safe-name.txt'), true);
});

test('agent file policy blocks common credential and private-key names', () => {
  for (const name of ['.env', '.env.production', '.npmrc', '.pypirc', '.netrc', 'id_rsa', 'id_ecdsa', 'app-passwords.json', 'server.pem', 'private_key.p12']) {
    assert.equal(isSensitiveAgentFilename(name), true, name);
  }
  assert.equal(isSensitiveAgentFilename('README.md'), false);
  assert.equal(isSensitiveAgentFilename('configuration.json'), false);
});
