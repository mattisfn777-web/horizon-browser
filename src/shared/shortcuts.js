'use strict';
/**
 * Keyboard shortcut table shared by the main process (for keys pressed while a
 * web page has focus) and the browser UI (for keys pressed in the toolbar).
 * Input shape: { key, ctrl, shift, alt }  ->  returns an action name or null.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.HZ_matchShortcut = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const CTRL = {
    t: 'new-tab', w: 'close-tab', n: 'new-window', l: 'focus-address', r: 'reload',
    d: 'bookmark', f: 'find', h: 'history', j: 'downloads', p: 'print', ',': 'settings',
    '=': 'zoom-in', '+': 'zoom-in', '-': 'zoom-out', '_': 'zoom-out', '0': 'zoom-reset',
    Tab: 'next-tab', PageDown: 'next-tab', PageUp: 'prev-tab', F5: 'hard-reload',
  };
  const CTRL_SHIFT = {
    t: 'reopen-tab', n: 'new-private', r: 'hard-reload', b: 'bookmarks', i: 'devtools',
    Tab: 'prev-tab', '+': 'zoom-in', '=': 'zoom-in', '_': 'zoom-out', '-': 'zoom-out',
  };
  const ALT = { ArrowLeft: 'back', ArrowRight: 'forward', Home: 'home', d: 'focus-address' };
  const PLAIN = { F5: 'reload', F6: 'focus-address', F11: 'fullscreen', F12: 'devtools', Escape: 'escape' };

  return function match(i) {
    if (!i) return null;
    const raw = String(i.key == null ? '' : i.key);
    const key = raw.length === 1 ? raw.toLowerCase() : raw;
    if (i.ctrl && !i.alt) {
      if (/^[1-9]$/.test(key) && !i.shift) return key === '9' ? 'tab-last' : 'tab-' + key;
      return (i.shift ? CTRL_SHIFT : CTRL)[key] || null;
    }
    if (i.alt && !i.ctrl && !i.shift) return ALT[key] || null;
    if (!i.ctrl && !i.alt && !i.shift) return PLAIN[key] || null;
    return null;
  };
});
