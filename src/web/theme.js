'use strict';

// Apply the saved theme before styles and content load to avoid a bright flash.
(() => {
  let theme = 'dark';
  try {
    if (localStorage.getItem('pm2-notifier-theme') === 'light') theme = 'light';
  } catch { /* Private browser settings can make storage unavailable. */ }
  document.documentElement.dataset.theme = theme;
})();
