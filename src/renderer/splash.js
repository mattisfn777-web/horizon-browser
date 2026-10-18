'use strict';
const $ = (id) => document.getElementById(id);
let currentText = '';

window.splash.onStatus((s) => {
  if (s.text && s.text !== currentText) {
    currentText = s.text;
    const el = $('status');
    el.classList.add('swap');
    setTimeout(() => { el.textContent = s.text; el.classList.remove('swap'); }, 140);
  }
  const bar = $('bar');
  if ('progress' in s) {
    const determinate = typeof s.progress === 'number';
    bar.classList.toggle('indeterminate', !determinate);
    if (determinate) $('fill').style.width = Math.max(0, Math.min(1, s.progress)) * 100 + '%';
    else $('fill').style.width = '';
  }
  bar.classList.toggle('error', s.phase === 'error');
  bar.classList.toggle('done', s.phase === 'uptodate');
  if ('detail' in s) $('detail').textContent = s.detail || '\u00a0';
  if (s.appVersion) $('ver').textContent = 'Version ' + s.appVersion;
});
