const test = require('node:test');
const assert = require('node:assert/strict');
const { buildPathParts } = require('../out/test-webview/components/path-bar/path-parts.js');

test('UNC path keeps the server share as its clickable root', () => {
  const parts = buildPathParts('\\\\server\\share\\', 'local', true);
  assert.deepEqual(parts, [{ label: '//server/share/', path: '//server/share/', isRoot: true, clickable: true, separatorBefore: false }]);
});

test('UNC child breadcrumbs stay within the network share and truncate old folders', () => {
  const parts = buildPathParts('\\\\server\\share\\one\\two\\three\\four\\five', 'local', true);
  assert.equal(parts[0].path, '//server/share/');
  assert.equal(parts[1].ellipsis, true);
  assert.deepEqual(parts.slice(-3).map((part) => [part.label, part.path, part.clickable]), [
    ['three', '//server/share/one/two/three', true],
    ['four', '//server/share/one/two/three/four', true],
    ['five', '//server/share/one/two/three/four/five', false]
  ]);
});

test('POSIX and drive roots retain their existing breadcrumb paths', () => {
  assert.equal(buildPathParts('/srv/www/site', 'local', true)[0].path, '/');
  assert.deepEqual(buildPathParts('C:\\Users\\dev', 'local', true).map((part) => part.path), ['C:/', 'C:/Users', 'C:/Users/dev']);
});
