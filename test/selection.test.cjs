const test = require('node:test');
const assert = require('node:assert/strict');
const { hasVisibleFileSelection, isSelectionToggleKey, reconcileSelection, selectionModeForModifiers, updateSelection } = require('../out/test-webview/selection.js');

const entries = [
  { name: 'alpha.txt', path: '/alpha.txt', kind: 'file' },
  { name: 'folder', path: '/folder', kind: 'directory' },
  { name: 'beta.txt', path: '/beta.txt', kind: 'file' },
  { name: 'omega', path: '/omega', kind: 'directory' }
];

test('plain click replaces the selection and supports both files and folders', () => {
  const state = updateSelection(entries, ['/alpha.txt', '/folder'], '/alpha.txt', '/omega', 'replace');
  assert.deepEqual(state, { paths: ['/omega'], anchorPath: '/omega' });
});

test('Ctrl-click and Command-click modifiers both toggle an individual item', () => {
  assert.equal(selectionModeForModifiers({ shiftKey: false, ctrlKey: true, metaKey: false }), 'toggle');
  assert.equal(selectionModeForModifiers({ shiftKey: false, ctrlKey: false, metaKey: true }), 'toggle');
  assert.deepEqual(updateSelection(entries, ['/alpha.txt'], '/alpha.txt', '/folder', 'toggle').paths, ['/alpha.txt', '/folder']);
  assert.deepEqual(updateSelection(entries, ['/alpha.txt'], '/alpha.txt', '/alpha.txt', 'toggle').paths, []);
});

test('Shift-click selects an inclusive range in either direction, including folders', () => {
  assert.deepEqual(updateSelection(entries, ['/omega'], '/alpha.txt', '/beta.txt', 'range').paths, ['/alpha.txt', '/folder', '/beta.txt']);
  assert.deepEqual(updateSelection(entries, ['/omega'], '/omega', '/folder', 'range').paths, ['/folder', '/beta.txt', '/omega']);
  assert.equal(selectionModeForModifiers({ shiftKey: true, ctrlKey: false, metaKey: false }), 'range');
});

test('Shift with Ctrl or Command adds a range to the existing selection', () => {
  assert.equal(selectionModeForModifiers({ shiftKey: true, ctrlKey: true, metaKey: false }), 'add-range');
  assert.equal(selectionModeForModifiers({ shiftKey: true, ctrlKey: false, metaKey: true }), 'add-range');
  const state = updateSelection(entries, ['/omega'], '/alpha.txt', '/beta.txt', 'add-range');
  assert.deepEqual(state.paths, ['/omega', '/alpha.txt', '/folder', '/beta.txt']);
});

test('a range without a visible anchor selects only the target and establishes a new anchor', () => {
  assert.deepEqual(updateSelection(entries, ['/omega'], '/hidden', '/folder', 'range'), { paths: ['/folder'], anchorPath: '/folder' });
  assert.deepEqual(updateSelection(entries, [], '', '/folder', 'add-range'), { paths: ['/folder'], anchorPath: '/folder' });
});

test('Insert and Space are the keyboard selection toggles', () => {
  assert.equal(isSelectionToggleKey('Insert'), true);
  assert.equal(isSelectionToggleKey(' '), true);
  assert.equal(isSelectionToggleKey('Enter'), false);
});

test('select-all callers can prune hidden or deleted entries without losing folders in view', () => {
  assert.deepEqual(reconcileSelection(entries, ['/alpha.txt', '/folder', '/hidden', '/folder']), ['/alpha.txt', '/folder']);
  assert.deepEqual(reconcileSelection([], ['/alpha.txt']), []);
});

test('single-file actions remain unavailable for folder or multi-item selections', () => {
  assert.equal(hasVisibleFileSelection(entries, '/folder', ''), false);
  assert.equal(hasVisibleFileSelection(entries, '/alpha.txt', 'alpha'), true);
  assert.equal(hasVisibleFileSelection(entries, '/alpha.txt', 'beta'), false);
  assert.equal(hasVisibleFileSelection(entries, '', ''), false);
});
