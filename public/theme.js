/* =============================================================================
 * theme.js — toggle light/dark para la Biblioteca Orden Nacional
 *
 * Este script se carga en el <head> de cada página (index, book, section) de
 * forma síncrona, ANTES del stylesheet, para evitar el flash del tema
 * incorrecto: lo primero que hace es leer la preferencia guardada (o la del
 * sistema operativo) y fijar el atributo data-theme en <html>.
 *
 * Cuando el DOM está listo, agrega un botón fijo en top-right que alterna
 * entre los dos temas y guarda la elección en localStorage.
 *
 * Atajo de teclado: "d" (siempre que el foco no esté en un input/select).
 * =============================================================================
 */
(function () {
    const STORAGE_KEY = 'bon-theme';

    // -- 1. Aplicar tema lo antes posible (evita flash) ----------------------
    function resolveInitialTheme() {
        try {
            const saved = localStorage.getItem(STORAGE_KEY);
            if (saved === 'light' || saved === 'dark') return saved;
        } catch (_) { /* localStorage bloqueado */ }

        if (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) {
            return 'light';
        }
        return 'dark';
    }

    const current = resolveInitialTheme();
    document.documentElement.setAttribute('data-theme', current);

    // -- 2. Montar el botón cuando el <body> exista --------------------------
    const SUN_SVG  = '<svg class="theme-toggle-icon" viewBox="0 0 24 24" aria-hidden="true">'
        + '<circle cx="12" cy="12" r="4.2"/>'
        + '<g stroke-linecap="round">'
        + '<line x1="12" y1="2.5"  x2="12" y2="5"/>'
        + '<line x1="12" y1="19"   x2="12" y2="21.5"/>'
        + '<line x1="2.5"  y1="12" x2="5"  y2="12"/>'
        + '<line x1="19"   y1="12" x2="21.5" y2="12"/>'
        + '<line x1="5.2"  y1="5.2"  x2="6.95" y2="6.95"/>'
        + '<line x1="17.05" y1="17.05" x2="18.8" y2="18.8"/>'
        + '<line x1="5.2"  y1="18.8"  x2="6.95" y2="17.05"/>'
        + '<line x1="17.05" y1="6.95" x2="18.8" y2="5.2"/>'
        + '</g></svg>';

    const MOON_SVG = '<svg class="theme-toggle-icon" viewBox="0 0 24 24" aria-hidden="true">'
        + '<path d="M20.5 14.2A8.5 8.5 0 1 1 9.8 3.5a7 7 0 0 0 10.7 10.7z"/>'
        + '</svg>';

    function mount() {
        if (document.getElementById('themeToggle')) return; // evitar doble mount

        const btn = document.createElement('button');
        btn.id = 'themeToggle';
        btn.className = 'theme-toggle';
        btn.type = 'button';
        btn.setAttribute('aria-label', 'cambiar entre modo claro y oscuro');
        btn.setAttribute('title', 'cambiar tema (d)');

        function render() {
            const t = document.documentElement.getAttribute('data-theme');
            // En modo oscuro mostramos el sol (clickear te lleva a la luz).
            // En modo claro mostramos la luna.
            btn.innerHTML = t === 'light' ? MOON_SVG : SUN_SVG;
        }
        render();

        btn.addEventListener('click', function () {
            const t = document.documentElement.getAttribute('data-theme');
            const next = t === 'light' ? 'dark' : 'light';
            document.documentElement.setAttribute('data-theme', next);
            try { localStorage.setItem(STORAGE_KEY, next); } catch (_) {}
            render();
        });

        document.body.appendChild(btn);

        // Atajo: tecla "d" (mientras no estés escribiendo en un campo)
        document.addEventListener('keydown', function (e) {
            if (e.key !== 'd' && e.key !== 'D') return;
            const el = document.activeElement;
            if (el && ['INPUT', 'TEXTAREA', 'SELECT'].indexOf(el.tagName) !== -1) return;
            if (e.metaKey || e.ctrlKey || e.altKey) return;
            e.preventDefault();
            btn.click();
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', mount);
    } else {
        mount();
    }
})();
