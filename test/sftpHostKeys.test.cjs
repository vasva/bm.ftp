const test = require('node:test');
const assert = require('node:assert/strict');
const { commitHostKey, getHostKeyFingerprint, getHostKeyStorageKey, stageHostKey } = require('../out/sftpHostKeys.js');

function store(values = new Map()) {
  return {
    values,
    async get(key) { return values.get(key); },
    async store(key, value) { values.set(key, value); }
  };
}

test('SFTP TOFU stages unknown key until explicit trust and keys identity by normalized host and port', async () => {
  const secrets = store();
  const key = Buffer.from('fixture-public-key');
  let prompt;
  const candidate = await stageHostKey(secrets, 'EXAMPLE.test', 2222, 'ssh-ed25519', key, async (message, changed) => {
    prompt = { message, changed };
    return 'trust';
  }, () => true);
  assert.equal(prompt.changed, false);
  assert.match(prompt.message, /SHA256:/);
  assert.equal(secrets.values.size, 0);
  await commitHostKey(secrets, candidate, () => true);
  assert.equal(secrets.values.size, 1);
  assert.equal(getHostKeyStorageKey('example.TEST', 2222), candidate.storageKey);
  assert.notEqual(getHostKeyStorageKey('example.test', 22), candidate.storageKey);
  assert.match(JSON.parse(secrets.values.get(candidate.storageKey)).fingerprint, /^SHA256:/);
  assert.equal(getHostKeyFingerprint(key), JSON.parse(secrets.values.get(candidate.storageKey)).fingerprint);
});

test('matching SFTP key proceeds silently while changed key requires the distinct replacement choice', async () => {
  const secrets = store();
  const original = Buffer.from('first key');
  const first = await stageHostKey(secrets, 'host.test', 22, 'ssh-ed25519', original, async () => 'trust', () => true);
  await commitHostKey(secrets, first, () => true);
  const matching = await stageHostKey(secrets, 'host.test', 22, 'ssh-ed25519', original, async () => { throw new Error('unexpected prompt'); }, () => true);
  assert.equal(matching.shouldStore, false);

  const changed = Buffer.from('replacement key');
  let warning;
  const replacement = await stageHostKey(secrets, 'host.test', 22, 'rsa-sha2-256', changed, async (message, isChanged) => {
    warning = { message, isChanged };
    return 'replace';
  }, () => true);
  assert.equal(warning.isChanged, true);
  assert.ok(warning.message.includes(getHostKeyFingerprint(original)));
  assert.ok(warning.message.includes(getHostKeyFingerprint(changed)));
  await commitHostKey(secrets, replacement, () => true);
  assert.equal(JSON.parse(secrets.values.get(replacement.storageKey)).publicKey, changed.toString('base64'));
});

test('cancelled, stale, malformed, or concurrently changed trust decisions cannot write a key', async () => {
  const secrets = store();
  const key = Buffer.from('candidate');
  await assert.rejects(stageHostKey(secrets, 'cancel.test', 22, 'ssh-ed25519', key, async () => undefined, () => true), /not trusted/);
  await assert.rejects(stageHostKey(secrets, 'stale.test', 22, 'ssh-ed25519', key, async () => 'trust', () => false), /no longer current/);
  assert.equal(secrets.values.size, 0);

  const malformedKey = getHostKeyStorageKey('broken.test', 22);
  secrets.values.set(malformedKey, '{');
  await assert.rejects(stageHostKey(secrets, 'broken.test', 22, 'ssh-ed25519', key, async () => 'trust', () => true), /unreadable/);

  const storageKey = getHostKeyStorageKey('race.test', 22);
  const staged = await stageHostKey(secrets, 'race.test', 22, 'ssh-ed25519', key, async () => 'trust', () => true);
  secrets.values.set(storageKey, JSON.stringify({ version: 1, host: 'race.test', port: 22, algorithm: 'ssh-ed25519', fingerprint: 'newer', publicKey: 'newer', acceptedAt: 'now' }));
  await assert.rejects(commitHostKey(secrets, staged, () => true), /changed while you were connecting/);
});

test('host-key storage read and write failures stay explicit', async () => {
  const brokenRead = { async get() { throw new Error('secret store unavailable'); }, async store() {} };
  await assert.rejects(stageHostKey(brokenRead, 'read.test', 22, 'ssh-ed25519', Buffer.from('key'), async () => 'trust', () => true), /secret store unavailable/);

  const brokenWrite = { async get() { return undefined; }, async store() { throw new Error('secret store write failed'); } };
  const candidate = await stageHostKey(brokenWrite, 'write.test', 22, 'ssh-ed25519', Buffer.from('key'), async () => 'trust', () => true);
  await assert.rejects(commitHostKey(brokenWrite, candidate, () => true), /secret store write failed/);
});
