'use strict';
// Private window additional logic.
// The shared browser.js handles core functionality.
// IS_PRIVATE = true (set via data-is-private="true" in HTML)

document.title = 'Horizon — Private';

// Ensure no history panel button exists in private
// (already not in the HTML, this is just a safety guard)
const pmHistory = document.getElementById('pm-history');
if (pmHistory) pmHistory.remove();

const pmBookmarks = document.getElementById('pm-bookmarks');
if (pmBookmarks) pmBookmarks.remove();

const pmSettings = document.getElementById('pm-settings');
if (pmSettings) pmSettings.remove();
