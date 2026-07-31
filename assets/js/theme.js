(function(){
  var mode = localStorage.getItem('af_theme_mode') || (localStorage.getItem('af_dark_mode') === '1' ? 'dark' : 'system');
  var systemDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  var dark = mode === 'dark' || (mode === 'system' && systemDark);
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
})();
