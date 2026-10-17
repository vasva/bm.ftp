const test = require('node:test');
const assert = require('node:assert/strict');
const { blockBackgroundKeydown, keepModalKeyboardFocus } = require('../out/test-webview/modal-keyboard.js');

function keyEvent(key) {
  return { key, prevented: false, stopped: false, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; } };
}

test('open modal blocks background shortcuts while a closed modal leaves them untouched', () => {
  const blocked = keyEvent('f');
  assert.equal(blockBackgroundKeydown(true, blocked), true);
  assert.equal(blocked.prevented, true);

  const allowed = keyEvent('f');
  assert.equal(blockBackgroundKeydown(false, allowed), false);
  assert.equal(allowed.prevented, false);
});

test('error dialog traps Tab, dismisses on Escape, and stops keyboard bubbling', () => {
  let focused = 0;
  let dismissed = 0;
  const tab = keyEvent('Tab');
  keepModalKeyboardFocus(tab, () => focused++, () => dismissed++);
  assert.equal(focused, 1);
  assert.equal(tab.prevented, true);
  assert.equal(tab.stopped, true);

  const escape = keyEvent('Escape');
  keepModalKeyboardFocus(escape, () => focused++, () => dismissed++);
  assert.equal(dismissed, 1);
  assert.equal(escape.prevented, true);
  assert.equal(escape.stopped, true);
});

test('copy dialog retains focus on Tab and does not treat Escape as cancel', () => {
  let focused = 0;
  const tab = keyEvent('Tab');
  keepModalKeyboardFocus(tab, () => focused++);
  assert.equal(focused, 1);
  assert.equal(tab.prevented, true);

  const escape = keyEvent('Escape');
  keepModalKeyboardFocus(escape, () => focused++);
  assert.equal(escape.prevented, false);
  assert.equal(focused, 1);
});
