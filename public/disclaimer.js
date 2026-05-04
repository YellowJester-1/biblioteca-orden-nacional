/* =============================================================================
 * disclaimer.js — botón flotante con aviso legal / privacidad
 *
 * Monta debajo del toggle de tema un botón circular bordó con un ícono de
 * alerta. Al hacer click abre un modal con dos puntos:
 *   1) el sitio no guarda cookies, IP ni información de los visitantes
 *   2) el sitio no aloja libros — es solo un indexador
 *
 * Se carga en index, book, section y admin junto a theme.js.
 * =============================================================================
 */
(function () {
    if (window.__disclaimerMounted) return;
    window.__disclaimerMounted = true;

    // Triángulo con signo de exclamación — ícono de alerta clásico.
    const ALERT_SVG =
        '<svg class="disclaimer-toggle-icon" viewBox="0 0 24 24" aria-hidden="true">'
        + '<path d="M12 3 L22 20 H2 Z" fill="none" stroke="currentColor" '
        +   'stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>'
        + '<line x1="12" y1="10" x2="12" y2="15" stroke="currentColor" '
        +   'stroke-width="2" stroke-linecap="round"/>'
        + '<circle cx="12" cy="17.6" r="1" fill="currentColor"/>'
        + '</svg>';

    function buildModal() {
        const overlay = document.createElement('div');
        overlay.className = 'modal disclaimer-modal';
        overlay.id = 'disclaimerModal';
        overlay.hidden = true;
        overlay.innerHTML = ''
            + '<div class="modal-backdrop" data-close></div>'
            + '<div class="modal-card disclaimer-card" role="dialog" '
            +     'aria-labelledby="disclaimerTitle" aria-modal="true">'
            +   '<button type="button" class="modal-close" data-close '
            +       'aria-label="Cerrar">×</button>'
            +   '<div class="modal-overline">aviso</div>'
            +   '<h2 class="modal-title" id="disclaimerTitle">Sobre este sitio</h2>'
            +   '<div class="disclaimer-body">'
            +     '<section class="disclaimer-block">'
            +       '<h3 class="disclaimer-heading">Privacidad</h3>'
            +       '<p>'
            +         'Este sitio no guarda cookies, no registra direcciones IP '
            +         'y no almacena ningún tipo de información sobre las '
            +         'personas que lo visitan. No hay analítica, no hay '
            +         'rastreadores y no hay cuentas de usuario públicas.'
            +       '</p>'
            +     '</section>'
            +     '<section class="disclaimer-block">'
            +       '<h3 class="disclaimer-heading">Catálogo de enlaces</h3>'
            +       '<p>'
            +         'El servidor de este sitio no aloja libros: la '
            +         'Biblioteca Orden Nacional funciona como un catálogo '
            +         'que organiza, describe y enlaza obras hospedadas en '
            +         'otros lugares. La responsabilidad sobre los contenidos '
            +         'enlazados recae sobre quienes los hospedan.'
            +       '</p>'
            +     '</section>'
            +   '</div>'
            +   '<div class="modal-footer">'
            +     '<button type="button" class="modal-btn modal-btn-primary" '
            +         'data-close>Entendido</button>'
            +   '</div>'
            + '</div>';
        return overlay;
    }

    function mount() {
        if (document.getElementById('disclaimerToggle')) return;

        const btn = document.createElement('button');
        btn.id = 'disclaimerToggle';
        btn.className = 'disclaimer-toggle';
        btn.type = 'button';
        btn.setAttribute('aria-label', 'aviso legal y de privacidad');
        btn.setAttribute('title', 'Aviso');
        btn.innerHTML = ALERT_SVG;

        const modal = buildModal();
        document.body.appendChild(btn);
        document.body.appendChild(modal);

        let lastFocus = null;

        function open() {
            lastFocus = document.activeElement;
            modal.hidden = false;
            document.body.classList.add('modal-open');
            // Enfocamos el botón "Entendido" para que ESC y Enter funcionen
            const ok = modal.querySelector('.modal-btn-primary');
            setTimeout(() => ok && ok.focus(), 40);
        }
        function close() {
            modal.hidden = true;
            document.body.classList.remove('modal-open');
            if (lastFocus && lastFocus.focus) lastFocus.focus();
        }

        btn.addEventListener('click', open);
        modal.addEventListener('click', (e) => {
            if (e.target.closest('[data-close]')) close();
        });
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && !modal.hidden) close();
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', mount);
    } else {
        mount();
    }
})();
