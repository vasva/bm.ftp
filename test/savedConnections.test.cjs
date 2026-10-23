const test = require('node:test');
const assert = require('node:assert/strict');
const { addSavedProfile, profileIdentity, readSavedProfiles, removeSavedProfile } = require('../out/savedConnections.js');

const ftp = { host: 'Files.Example', port: 21, username: 'Alice', protocol: 'ftp' };

test('saved profiles ignore malformed entries and duplicate host casing', () => {
  assert.deepEqual(readSavedProfiles([ftp, { ...ftp, host: 'files.example' }, { host: 'bad host', username: 'x' }, { host: 'other.example', username: 'x' }, null]), [ftp]);
  assert.deepEqual(readSavedProfiles({ profiles: [ftp] }), []);
});

test('identity separates port, protocol, and case-sensitive usernames', () => {
  assert.equal(profileIdentity(ftp), profileIdentity({ ...ftp, host: 'files.example' }));
  for (const distinct of [
    { ...ftp, port: 2121 }, { ...ftp, protocol: 'ftps' },
    { ...ftp, protocol: 'sftp', port: 22 }, { ...ftp, username: 'alice' }
  ]) assert.notEqual(profileIdentity(ftp), profileIdentity(distinct));
});

test('adding and removing a saved connection affects only the exact identity', () => {
  const sftp = { host: ftp.host, port: 22, username: ftp.username, protocol: 'sftp' };
  const profiles = addSavedProfile([ftp], sftp);
  assert.equal(profiles.length, 2);
  assert.strictEqual(addSavedProfile(profiles, { ...ftp, host: 'files.example' }), profiles);
  assert.deepEqual(removeSavedProfile(profiles, ftp), [sftp]);
});
