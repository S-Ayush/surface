// The inline script in apps/web/index.html that sets data-theme before the first paint, so the page
// never flashes the wrong theme (SPEC-005 §6, PLAN-005 S1). index.html must contain exactly this code
// (apps/web/src/styles/theme-bootstrap.test.ts); its behaviour is tested against resolveTheme().
// Plain ES5 with no dependencies: it runs before any bundle loads. The storage key must stay equal to
// THEME_STORAGE_KEY ('surface.theme').
export const THEME_BOOTSTRAP_SCRIPT = `
(function () {
  var preference = null;
  try {
    preference = window.localStorage.getItem('surface.theme');
  } catch (e) {}
  var dark =
    preference === 'dark' ||
    (preference !== 'light' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
})();
`;
