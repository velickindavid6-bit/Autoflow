document.documentElement.classList.add('js');
// Адреса страниц. На настоящем сервере остаются как есть ("/login"); в статической демо-версии для GitHub Pages
// подменяются на "login.html" и т.д. (см. scripts/build-demo.mjs). Весь код навигации вызывает эту функцию.
window.afUrl = window.afUrl || function (p) { return p; };
