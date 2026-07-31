(function(){
  var dark = localStorage.getItem('af_dark_mode') === '1';
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
})();
