// -----------------------------------------------------------------------------
// Biblioteca Orden Nacional — servidor Node + MySQL
// -----------------------------------------------------------------------------
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const mysql = require('mysql2/promise');
const PDFDocument = require('pdfkit');
const archiver = require('archiver');
const multer = require('multer');

// -----------------------------------------------------------------------------
// Uploads (portadas de aportes)
// -----------------------------------------------------------------------------
const UPLOADS_DIR = path.join(__dirname, 'public', 'uploads', 'covers');
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const ALLOWED_IMG_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

const coverStorage = multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
    filename: (_req, file, cb) => {
        const ext  = (path.extname(file.originalname) || '').toLowerCase().replace(/[^.\w]/g, '').slice(0, 10);
        const rand = crypto.randomBytes(8).toString('hex');
        cb(null, `${Date.now()}-${rand}${ext || '.bin'}`);
    },
});
const coverUpload = multer({
    storage: coverStorage,
    limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
    fileFilter: (_req, file, cb) => {
        if (!file.mimetype || ALLOWED_IMG_MIME.has(file.mimetype)) return cb(null, true);
        cb(new Error('formato de imagen no permitido'));
    },
});

// Mapeo categoría → sección (mismas claves que init.sql).
// Lo usamos al aceptar un aporte para deducir la sección automáticamente.
const CATEGORY_TO_SECTION = {
    novela:   'A',
    cuento:   'B',
    poesia:   'C',
    ensayo:   'D',
    historia: 'E',
    teatro:   'F',
};

// Mapeo inverso: sección → slug de categoría. Lo usamos cuando en el frontend
// solamente seleccionan sección (la columna category_id de books y
// category_slug de contributions siguen siendo NOT NULL en el esquema, así
// que igual hace falta inferir una categoría coherente).
const SECTION_TO_CATEGORY_SLUG = {
    A: 'novela',
    B: 'cuento',
    C: 'poesia',
    D: 'ensayo',
    E: 'historia',
    F: 'teatro',
};
const ALLOWED_SECTIONS = new Set(Object.keys(SECTION_TO_CATEGORY_SLUG));

// Idiomas soportados para tags de aportes (libro y audiolibro).
// El cliente los pide vía GET /api/languages para no duplicar la fuente.
const LANGUAGES = [
    { slug: 'es', name: 'español'   },
    { slug: 'en', name: 'inglés'    },
    { slug: 'fr', name: 'francés'   },
    { slug: 'de', name: 'alemán'    },
    { slug: 'it', name: 'italiano'  },
    { slug: 'pt', name: 'portugués' },
    { slug: 'ru', name: 'ruso'      },
    { slug: 'ja', name: 'japonés'   },
    { slug: 'la', name: 'latín'     },
    { slug: 'el', name: 'griego'    },
];
const LANGUAGE_SLUGS = new Set(LANGUAGES.map(l => l.slug));

// Parsea un campo `links_*_json` que viene como string JSON desde el form
// (por ejemplo: '{"es":"https://…","en":"https://…"}'). Devuelve un string
// JSON normalizado listo para guardar en una columna JSON, o null.
// Sólo acepta pares (slug, url) con slug en LANGUAGE_SLUGS y url no vacía,
// truncada a 500 chars.
function parseLinksJson(raw) {
    if (raw == null) return null;
    let obj;
    try { obj = JSON.parse(String(raw)); }
    catch (_) { return null; }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
    const out = {};
    Object.keys(obj).forEach(k => {
        const slug = String(k || '').trim().toLowerCase();
        const url  = String(obj[k] || '').trim().slice(0, 500);
        if (!slug || !url) return;
        if (!LANGUAGE_SLUGS.has(slug)) return;
        out[slug] = url;
    });
    return Object.keys(out).length ? JSON.stringify(out) : null;
}

// Normaliza un campo de idiomas (puede venir como CSV o como array repetido en
// el FormData) a un CSV ordenado, sin duplicados, y sólo con slugs válidos.
function normalizeLanguages(raw) {
    if (raw == null) return null;
    let parts = [];
    if (Array.isArray(raw))      parts = raw;
    else if (typeof raw === 'string') parts = raw.split(',');
    else                          return null;
    const out = [];
    const seen = new Set();
    parts.forEach(p => {
        const slug = String(p || '').trim().toLowerCase();
        if (!slug || seen.has(slug) || !LANGUAGE_SLUGS.has(slug)) return;
        seen.add(slug);
        out.push(slug);
    });
    return out.length ? out.join(',') : null;
}

// Borra del disco la portada subida si tuvimos que abortar la inserción
// (validación fallida, error de DB, etc.). req.file viene de multer.single.
function cleanupCover(file) {
    if (!file || !file.path) return;
    fs.unlink(file.path, (err) => {
        if (err && err.code !== 'ENOENT') {
            console.warn('[uploads] no se pudo borrar', file.path, err.message);
        }
    });
}

// Borra una portada vieja a partir de su web path (ej: /uploads/covers/abc.png).
// Sólo opera dentro de UPLOADS_DIR — no toca paths de otros sitios.
function cleanupCoverByWebPath(webPath) {
    if (!webPath) return;
    if (!webPath.startsWith('/uploads/covers/')) return;
    const fsPath = path.join(UPLOADS_DIR, path.basename(webPath));
    fs.unlink(fsPath, (err) => {
        if (err && err.code !== 'ENOENT') {
            console.warn('[uploads] no se pudo borrar', fsPath, err.message);
        }
    });
}

// ALTER TABLE ADD COLUMN idempotente — útil para volúmenes existentes.
async function addColumnIfMissing(pool, table, column, definition) {
    try {
        await pool.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`);
        console.log(`[db] columna ${column} agregada a ${table}`);
    } catch (err) {
        if (err && err.code === 'ER_DUP_FIELDNAME') return; // ya existe
        throw err;
    }
}

// -----------------------------------------------------------------------------
// Configuración de admin (oculto, login con cookie firmada HMAC)
// -----------------------------------------------------------------------------
const ADMIN_USER     = process.env.ADMIN_USER     || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin';
const ADMIN_SECRET   = process.env.ADMIN_SECRET   || 'change-me-in-prod-please';
const COOKIE_NAME    = 'bon_admin';
const SESSION_MS     = 24 * 60 * 60 * 1000; // 24h

if (ADMIN_SECRET === 'change-me-in-prod-please') {
    console.warn('[admin] ADMIN_SECRET no está seteado. Usá una variable de entorno en producción.');
}

function b64url(buf) {
    return Buffer.from(buf).toString('base64')
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
function b64urlDecode(s) {
    s = String(s).replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    return Buffer.from(s, 'base64');
}
function signToken(payload) {
    const body = b64url(JSON.stringify(payload));
    const mac  = crypto.createHmac('sha256', ADMIN_SECRET).update(body).digest('hex');
    return `${body}.${mac}`;
}
function verifyToken(token) {
    if (!token || typeof token !== 'string') return null;
    const dot = token.lastIndexOf('.');
    if (dot < 1) return null;
    const body = token.slice(0, dot);
    const mac  = token.slice(dot + 1);
    const expected = crypto.createHmac('sha256', ADMIN_SECRET).update(body).digest('hex');
    if (mac.length !== expected.length) return null;
    if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
    let payload;
    try { payload = JSON.parse(b64urlDecode(body).toString('utf8')); }
    catch (_) { return null; }
    if (!payload || typeof payload !== 'object') return null;
    if (!payload.exp || Date.now() > payload.exp) return null;
    return payload;
}
function parseCookies(req) {
    const header = req.headers.cookie || '';
    const out = {};
    header.split(';').forEach(part => {
        const i = part.indexOf('=');
        if (i < 0) return;
        const k = part.slice(0, i).trim();
        const v = part.slice(i + 1).trim();
        if (k) out[k] = decodeURIComponent(v);
    });
    return out;
}
function requireAdmin(req, res, next) {
    const cookies = parseCookies(req);
    const session = verifyToken(cookies[COOKIE_NAME]);
    if (!session || session.user !== ADMIN_USER) {
        return res.status(401).json({ error: 'no autorizado' });
    }
    req.adminSession = session;
    next();
}

// -----------------------------------------------------------------------------
// Contenido placeholder para las descargas (PDF / EPUB / audio)
// -----------------------------------------------------------------------------
const LOREM_PARAGRAPHS = [
    'Lorem ipsum dolor sit amet, consectetur adipiscing elit. In hac habitasse platea dictumst. Aenean vitae mauris nunc. Pharetra lectus a justo vehicula, in placerat dolor vulputate. Suspendisse potenti. Praesent nec lectus sed arcu luctus congue et vitae justo.',
    'Vestibulum ante ipsum primis in faucibus orci luctus et ultrices posuere cubilia curae; Curabitur euismod neque at metus porta, non efficitur velit dictum. Integer auctor est a magna consequat, non tincidunt risus volutpat. Morbi fringilla, arcu in bibendum tincidunt, lacus nibh sollicitudin mi, non eleifend lorem orci a nunc.',
    'Nulla facilisi. Donec consequat, tortor in pharetra convallis, lorem ipsum finibus arcu, at commodo risus elit nec nibh. Sed tincidunt, dolor et luctus posuere, mauris tellus congue metus, nec rhoncus enim sem eu elit. Vivamus ac velit nec ligula dictum tempor.',
    'Phasellus ac justo eu sapien tincidunt eleifend. Duis blandit, augue ac malesuada sagittis, velit purus tincidunt metus, a gravida odio neque vitae est. Cras posuere, neque non gravida volutpat, risus enim suscipit nibh, nec eleifend odio nibh nec nulla.',
    'Proin a elit vel sapien iaculis pharetra. Curabitur nec sapien nec nisl condimentum tincidunt. Aenean non turpis in nibh posuere efficitur. Suspendisse vitae mauris a lectus commodo bibendum ac non nulla. Fusce vitae metus nec lorem vulputate sodales.'
];

const NARRATORS = {
    'ana-marin':    'Ana Marín',
    'hugo-trelles': 'Hugo Trelles',
    'elena-rios':   'Elena Ríos',
    'mario-serna':  'Mario Serna'
};

function escapeXml(s) {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

function slugify(s) {
    return String(s)
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-zA-Z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .toLowerCase() || 'libro';
}

// WAV mono 8 kHz / 8 bits con silencio. ~32 KB por cada 4 seg.
function buildSilentWav(seconds = 4, sampleRate = 8000) {
    const dataSize = sampleRate * seconds;
    const buf = Buffer.alloc(44 + dataSize);
    buf.write('RIFF', 0);
    buf.writeUInt32LE(36 + dataSize, 4);
    buf.write('WAVE', 8);
    buf.write('fmt ', 12);
    buf.writeUInt32LE(16, 16);         // sub-chunk size
    buf.writeUInt16LE(1, 20);          // PCM
    buf.writeUInt16LE(1, 22);          // mono
    buf.writeUInt32LE(sampleRate, 24);
    buf.writeUInt32LE(sampleRate, 28); // byte rate
    buf.writeUInt16LE(1, 32);          // block align
    buf.writeUInt16LE(8, 34);          // bits per sample
    buf.write('data', 36);
    buf.writeUInt32LE(dataSize, 40);
    buf.fill(128, 44);                 // 128 = silencio en PCM 8-bit unsigned
    return buf;
}

const PORT = process.env.PORT || 3000;

const DB_CONFIG = {
    host: process.env.DB_HOST || 'db',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'orden',
    password: process.env.DB_PASSWORD || 'orden',
    database: process.env.DB_NAME || 'biblioteca',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    charset: 'utf8mb4',
};

// -----------------------------------------------------------------------------
// Conexión a MySQL con reintentos (MySQL tarda en estar listo en el primer boot)
// -----------------------------------------------------------------------------
async function createPoolWithRetry(maxAttempts = 30, delayMs = 2000) {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            const pool = mysql.createPool(DB_CONFIG);
            await pool.query('SELECT 1');
            console.log(`[db] Conectado a MySQL en ${DB_CONFIG.host}:${DB_CONFIG.port} (intento ${attempt})`);
            return pool;
        } catch (err) {
            console.log(`[db] Intento ${attempt}/${maxAttempts} falló: ${err.code || err.message}. Reintentando en ${delayMs}ms...`);
            await new Promise(r => setTimeout(r, delayMs));
        }
    }
    throw new Error('No se pudo conectar a MySQL después de varios intentos.');
}

// -----------------------------------------------------------------------------
// App
// -----------------------------------------------------------------------------
async function main() {
    const pool = await createPoolWithRetry();

    // Migración idempotente: garantiza la tabla `reports` sin tirar el volumen.
    // init.sql solo corre en volumen fresco; esto cubre el caso de una DB vieja.
    await pool.query(`
        CREATE TABLE IF NOT EXISTS reports (
            id         INT AUTO_INCREMENT PRIMARY KEY,
            book_id    INT NULL,
            message    TEXT NOT NULL,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            INDEX idx_reports_book (book_id),
            CONSTRAINT fk_reports_book
                FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE SET NULL
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    console.log('[db] tabla reports lista');

    // Workflow de moderación de reportes: status + fecha de decisión.
    await addColumnIfMissing(pool, 'reports', 'status',
        "ENUM('pending','resolved','dismissed') NOT NULL DEFAULT 'pending'");
    await addColumnIfMissing(pool, 'reports', 'decided_at', 'DATETIME NULL');

    // Migración idempotente: tabla `contributions` (cola de moderación)
    await pool.query(`
        CREATE TABLE IF NOT EXISTS contributions (
            id              INT AUTO_INCREMENT PRIMARY KEY,
            title           VARCHAR(200) NOT NULL,
            author          VARCHAR(150) NOT NULL,
            category_slug   VARCHAR(40)  NOT NULL,
            year            VARCHAR(20)  NULL,
            link_pdf        VARCHAR(500) NULL,
            link_epub       VARCHAR(500) NULL,
            fragment        TEXT NULL,
            notes           TEXT NULL,
            cover_path      VARCHAR(255) NULL,
            languages_book  VARCHAR(200) NULL,
            languages_audio VARCHAR(200) NULL,
            status          ENUM('pending','accepted','rejected') NOT NULL DEFAULT 'pending',
            book_id         INT NULL,
            created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            decided_at      DATETIME NULL,
            INDEX idx_contributions_status (status),
            CONSTRAINT fk_contrib_book
                FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE SET NULL
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    // Para volúmenes viejos: agregar columnas si no existen (MySQL 8 no soporta
    // ADD COLUMN IF NOT EXISTS, así que tragamos el ER_DUP_FIELDNAME).
    await addColumnIfMissing(pool, 'contributions', 'languages_book',  'VARCHAR(200) NULL AFTER cover_path');
    await addColumnIfMissing(pool, 'contributions', 'languages_audio', 'VARCHAR(200) NULL AFTER languages_book');
    await addColumnIfMissing(pool, 'contributions', 'link_audio',      'VARCHAR(500) NULL AFTER link_epub');
    // Links por idioma (objetos JSON {slug: url}) — versión nueva del modelo
    await addColumnIfMissing(pool, 'contributions', 'links_book',      'JSON NULL');
    await addColumnIfMissing(pool, 'contributions', 'links_audio',     'JSON NULL');
    // Aporte sobre un libro existente (idioma/versión faltante).
    // Cuando esto está seteado, accept() mergea sobre ese libro en vez de
    // crear uno nuevo.
    await addColumnIfMissing(pool, 'contributions', 'parent_book_id',  'INT NULL');
    console.log('[db] tabla contributions lista');

    // Migración idempotente: extender la tabla `books` para que pueda
    // alojar lo que un aporte aporta (portada, fragmento, links externos,
    // idiomas). Si los volúmenes antiguos no las tenían, se las agregamos.
    await addColumnIfMissing(pool, 'books', 'year',            'VARCHAR(20)  NULL AFTER author');
    await addColumnIfMissing(pool, 'books', 'cover_path',      'VARCHAR(255) NULL AFTER section');
    await addColumnIfMissing(pool, 'books', 'fragment',        'TEXT         NULL AFTER cover_path');
    await addColumnIfMissing(pool, 'books', 'link_pdf',        'VARCHAR(500) NULL AFTER fragment');
    await addColumnIfMissing(pool, 'books', 'link_epub',       'VARCHAR(500) NULL AFTER link_pdf');
    await addColumnIfMissing(pool, 'books', 'link_audio',      'VARCHAR(500) NULL AFTER link_epub');
    await addColumnIfMissing(pool, 'books', 'languages_book',  'VARCHAR(200) NULL AFTER link_audio');
    await addColumnIfMissing(pool, 'books', 'languages_audio', 'VARCHAR(200) NULL AFTER languages_book');
    await addColumnIfMissing(pool, 'books', 'links_book',      'JSON NULL');
    await addColumnIfMissing(pool, 'books', 'links_audio',     'JSON NULL');
    console.log('[db] tabla books extendida');

    const app = express();
    app.use(express.json());
    app.use(express.static(path.join(__dirname, 'public')));

    // --- API ---

    // Healthcheck
    app.get('/api/health', async (_req, res) => {
        try {
            await pool.query('SELECT 1');
            res.json({ status: 'ok', db: 'up' });
        } catch (err) {
            res.status(503).json({ status: 'degraded', db: 'down', error: err.message });
        }
    });

    // Listado de libros (con join a categorías)
    app.get('/api/books', async (_req, res) => {
        try {
            const [rows] = await pool.query(`
                SELECT b.id,
                       b.title,
                       b.author,
                       b.year,
                       b.section,
                       b.cover_path,
                       c.slug  AS category_slug,
                       c.name  AS category_name
                FROM books b
                JOIN categories c ON c.id = b.category_id
                ORDER BY b.section ASC, b.title ASC
            `);
            res.json(rows);
        } catch (err) {
            console.error('[api/books]', err);
            res.status(500).json({ error: 'No se pudo obtener el catálogo.' });
        }
    });

    // Detalle de un libro
    app.get('/api/books/:id', async (req, res) => {
        const id = Number.parseInt(req.params.id, 10);
        if (!Number.isFinite(id) || id <= 0) {
            return res.status(400).json({ error: 'id inválido' });
        }
        try {
            const [rows] = await pool.query(`
                SELECT b.id,
                       b.title,
                       b.author,
                       b.year,
                       b.section,
                       b.cover_path,
                       b.fragment,
                       b.link_pdf,
                       b.link_epub,
                       b.link_audio,
                       b.languages_book,
                       b.languages_audio,
                       b.links_book,
                       b.links_audio,
                       c.slug  AS category_slug,
                       c.name  AS category_name
                FROM books b
                JOIN categories c ON c.id = b.category_id
                WHERE b.id = ?
                LIMIT 1
            `, [id]);
            if (rows.length === 0) return res.status(404).json({ error: 'no encontrado' });
            res.json(rows[0]);
        } catch (err) {
            console.error('[api/books/:id]', err);
            res.status(500).json({ error: 'No se pudo obtener el libro.' });
        }
    });

    // Helper — trae un libro por id o devuelve null
    async function fetchBook(id) {
        const [rows] = await pool.query(`
            SELECT b.id, b.title, b.author, b.section,
                   c.slug AS category_slug, c.name AS category_name
            FROM books b JOIN categories c ON c.id = b.category_id
            WHERE b.id = ? LIMIT 1
        `, [id]);
        return rows[0] || null;
    }

    // Descarga PDF — generado con pdfkit al vuelo
    app.get('/api/books/:id/download.pdf', async (req, res) => {
        const id = Number.parseInt(req.params.id, 10);
        if (!Number.isFinite(id) || id <= 0) return res.status(400).send('id inválido');
        try {
            const book = await fetchBook(id);
            if (!book) return res.status(404).send('no encontrado');

            const filename = `${slugify(book.author)}-${slugify(book.title)}.pdf`;
            res.setHeader('Content-Type', 'application/pdf');
            res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

            const doc = new PDFDocument({ size: 'A5', margin: 54 });
            doc.pipe(res);

            doc.fontSize(9).fillColor('#8a8680')
               .text('BIBLIOTECA ORDEN NACIONAL', { align: 'center', characterSpacing: 3 });
            doc.moveDown(0.5);
            doc.fontSize(7).fillColor('#8a8680')
               .text(`Sección ${book.section} · ${book.category_name}`, { align: 'center' });

            doc.moveDown(6);
            doc.fontSize(22).fillColor('#111')
               .text(book.title, { align: 'center' });
            doc.moveDown(1);
            doc.fontSize(11).fillColor('#555')
               .text(book.author, { align: 'center', oblique: true });

            doc.moveDown(6);
            doc.fontSize(10).fillColor('#333');
            LOREM_PARAGRAPHS.forEach(p => {
                doc.text(p, { align: 'justify', indent: 18, lineGap: 3 });
                doc.moveDown(1);
            });

            doc.moveDown(2);
            doc.fontSize(7).fillColor('#8a8680')
               .text(`— registro ${String(book.id).padStart(4, '0')} · placeholder —`, { align: 'center' });

            doc.end();
        } catch (err) {
            console.error('[pdf]', err);
            if (!res.headersSent) res.status(500).send('error generando PDF');
        }
    });

    // Descarga EPUB — ZIP con estructura EPUB 2 mínima
    app.get('/api/books/:id/download.epub', async (req, res) => {
        const id = Number.parseInt(req.params.id, 10);
        if (!Number.isFinite(id) || id <= 0) return res.status(400).send('id inválido');
        try {
            const book = await fetchBook(id);
            if (!book) return res.status(404).send('no encontrado');

            const filename = `${slugify(book.author)}-${slugify(book.title)}.epub`;
            const uid = `bon-${book.id}-${Date.now()}`;

            res.setHeader('Content-Type', 'application/epub+zip');
            res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

            const archive = archiver('zip', { zlib: { level: 9 } });
            archive.on('error', err => { throw err; });
            archive.pipe(res);

            // mimetype tiene que ser la primera entrada y SIN compresión (store)
            archive.append('application/epub+zip', { name: 'mimetype', store: true });

            archive.append(
`<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
`, { name: 'META-INF/container.xml' });

            archive.append(
`<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="BookId" version="2.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="BookId">${escapeXml(uid)}</dc:identifier>
    <dc:title>${escapeXml(book.title)}</dc:title>
    <dc:creator>${escapeXml(book.author)}</dc:creator>
    <dc:language>es</dc:language>
    <dc:publisher>Biblioteca Orden Nacional</dc:publisher>
  </metadata>
  <manifest>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="ch1" href="chapter1.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine toc="ncx">
    <itemref idref="ch1"/>
  </spine>
</package>
`, { name: 'OEBPS/content.opf' });

            archive.append(
`<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head>
    <meta name="dtb:uid" content="${escapeXml(uid)}"/>
    <meta name="dtb:depth" content="1"/>
    <meta name="dtb:totalPageCount" content="0"/>
    <meta name="dtb:maxPageNumber" content="0"/>
  </head>
  <docTitle><text>${escapeXml(book.title)}</text></docTitle>
  <navMap>
    <navPoint id="nav1" playOrder="1">
      <navLabel><text>${escapeXml(book.title)}</text></navLabel>
      <content src="chapter1.xhtml"/>
    </navPoint>
  </navMap>
</ncx>
`, { name: 'OEBPS/toc.ncx' });

            const body = LOREM_PARAGRAPHS.map(p => `    <p>${escapeXml(p)}</p>`).join('\n');
            archive.append(
`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN" "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd">
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>${escapeXml(book.title)}</title></head>
<body>
  <h1>${escapeXml(book.title)}</h1>
  <p><em>${escapeXml(book.author)}</em></p>
  <hr/>
${body}
  <hr/>
  <p style="text-align:center;font-size:0.8em">— placeholder · Biblioteca Orden Nacional —</p>
</body>
</html>
`, { name: 'OEBPS/chapter1.xhtml' });

            archive.finalize();
        } catch (err) {
            console.error('[epub]', err);
            if (!res.headersSent) res.status(500).send('error generando EPUB');
        }
    });

    // Audiolibro placeholder — WAV con silencio. Acepta ?narrator=slug
    app.get('/api/books/:id/audio', async (req, res) => {
        const id = Number.parseInt(req.params.id, 10);
        if (!Number.isFinite(id) || id <= 0) return res.status(400).send('id inválido');
        try {
            const book = await fetchBook(id);
            if (!book) return res.status(404).send('no encontrado');

            const narratorSlug = String(req.query.narrator || 'ana-marin');
            if (!NARRATORS[narratorSlug]) return res.status(400).send('narrador inválido');

            const buf = buildSilentWav(4);
            const filename = `${slugify(book.author)}-${slugify(book.title)}-${narratorSlug}.wav`;
            res.setHeader('Content-Type', 'audio/wav');
            res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
            res.setHeader('Content-Length', buf.length);
            res.send(buf);
        } catch (err) {
            console.error('[audio]', err);
            if (!res.headersSent) res.status(500).send('error generando audio');
        }
    });

    // Listado de narradores disponibles
    app.get('/api/narrators', (_req, res) => {
        res.json(Object.entries(NARRATORS).map(([slug, name]) => ({ slug, name })));
    });

    // Reporte de enlace caído (u otro problema) en un libro
    app.post('/api/reports', async (req, res) => {
        const rawBookId  = req.body && req.body.book_id;
        const rawMessage = req.body && req.body.message;

        const bookId  = Number.parseInt(rawBookId, 10);
        const message = String(rawMessage || '').trim();

        if (message.length < 5) {
            return res.status(400).json({ error: 'el mensaje es muy corto' });
        }
        if (message.length > 2000) {
            return res.status(400).json({ error: 'el mensaje es demasiado largo' });
        }

        const finalBookId = Number.isFinite(bookId) && bookId > 0 ? bookId : null;

        try {
            const [result] = await pool.query(
                'INSERT INTO reports (book_id, message) VALUES (?, ?)',
                [finalBookId, message]
            );
            res.status(201).json({ ok: true, id: result.insertId });
        } catch (err) {
            console.error('[reports]', err);
            res.status(500).json({ error: 'no se pudo guardar el reporte' });
        }
    });

    // Listado de categorías
    app.get('/api/categories', async (_req, res) => {
        try {
            const [rows] = await pool.query(`
                SELECT id, slug, name
                FROM categories
                ORDER BY name ASC
            `);
            res.json(rows);
        } catch (err) {
            console.error('[api/categories]', err);
            res.status(500).json({ error: 'No se pudieron obtener las categorías.' });
        }
    });

    // Lista de idiomas soportados (para los tags de aporte)
    app.get('/api/languages', (_req, res) => {
        res.json(LANGUAGES);
    });

    // -------------------------------------------------------------------------
    // Aportes del público — cola de moderación
    // -------------------------------------------------------------------------

    // POST público: recibe el formulario del modal "aportar un título".
    // Multer parsea multipart/form-data, dejando los campos en req.body y la
    // portada (si vino) en req.file.
    app.post(
        '/api/contributions',
        (req, res, next) => {
            coverUpload.single('cover')(req, res, (err) => {
                if (err) {
                    if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
                        return res.status(413).json({ error: 'la portada supera 5 MB' });
                    }
                    return res.status(400).json({ error: err.message || 'archivo inválido' });
                }
                next();
            });
        },
        async (req, res) => {
            const body = req.body || {};
            const title    = String(body.title    || '').trim();
            const author   = String(body.author   || '').trim();
            // Aceptamos tanto `section` (preferido) como `category` (compat).
            // Si llegó section, derivamos el slug de categoría desde ella.
            const sectionRaw = String(body.section || '').trim().toUpperCase();
            let catSlug    = String(body.category || '').trim().toLowerCase();
            const year     = String(body.year     || '').trim().slice(0, 20) || null;
            const linkPdf   = String(body.link_pdf  || '').trim().slice(0, 500) || null;
            const linkEpub  = String(body.link_epub || '').trim().slice(0, 500) || null;
            const linkAudio = String(body.link_audio|| '').trim().slice(0, 500) || null;
            const fragment  = String(body.fragment  || '').trim().slice(0, 6000) || null;
            const notes    = String(body.notes    || '').trim().slice(0, 1000) || null;
            const langsBook  = normalizeLanguages(body.languages_book);
            const langsAudio = normalizeLanguages(body.languages_audio);
            const linksBook  = parseLinksJson(body.links_book_json);
            const linksAudio = parseLinksJson(body.links_audio_json);

            // Validación mínima
            if (!title || title.length > 200) {
                cleanupCover(req.file);
                return res.status(400).json({ error: 'título inválido' });
            }
            if (!author || author.length > 150) {
                cleanupCover(req.file);
                return res.status(400).json({ error: 'autor inválido' });
            }
            if (sectionRaw) {
                if (!ALLOWED_SECTIONS.has(sectionRaw)) {
                    cleanupCover(req.file);
                    return res.status(400).json({ error: 'sección inválida' });
                }
                // La sección manda: pisamos cualquier categoría legacy.
                catSlug = SECTION_TO_CATEGORY_SLUG[sectionRaw];
            }
            if (!catSlug) {
                cleanupCover(req.file);
                return res.status(400).json({ error: 'sección obligatoria' });
            }

            try {
                // Verificamos que la categoría derivada exista
                const [catRows] = await pool.query(
                    'SELECT id FROM categories WHERE slug = ? LIMIT 1', [catSlug]
                );
                if (catRows.length === 0) {
                    cleanupCover(req.file);
                    return res.status(400).json({ error: 'sección desconocida' });
                }

                const coverWebPath = req.file
                    ? `/uploads/covers/${req.file.filename}`
                    : null;

                const [result] = await pool.query(
                    `INSERT INTO contributions
                       (title, author, category_slug, year,
                        link_pdf, link_epub, link_audio, fragment, notes, cover_path,
                        languages_book, languages_audio, links_book, links_audio)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    [title, author, catSlug, year,
                     linkPdf, linkEpub, linkAudio, fragment, notes, coverWebPath,
                     langsBook, langsAudio, linksBook, linksAudio]
                );
                res.status(201).json({ ok: true, id: result.insertId });
            } catch (err) {
                console.error('[contributions]', err);
                cleanupCover(req.file);
                res.status(500).json({ error: 'no se pudo guardar el aporte' });
            }
        }
    );

    // POST público: aporte sobre un libro existente. Tiene dos modos:
    //  - "version": el aportante adjunta una versión/idioma (kind+language
    //    obligatorios, url opcional). En accept(), se mergea sobre el libro padre.
    //  - "note": observación o corrección (solo texto). En accept(), no toca el
    //    libro: el admin corrige a mano y luego marca atendido.
    // Crea una contribution "ligada" al libro padre vía parent_book_id.
    app.post('/api/contributions/version', async (req, res) => {
        const body = req.body || {};
        const bookId   = Number.parseInt(body.book_id, 10);
        const mode     = String(body.mode || 'version').trim().toLowerCase();
        const kind     = String(body.kind || '').trim().toLowerCase();
        const language = String(body.language || '').trim().toLowerCase();
        const url      = String(body.download_url || '').trim().slice(0, 500);
        const notes    = String(body.notes || '').trim().slice(0, 1000) || null;

        if (!Number.isFinite(bookId) || bookId <= 0) {
            return res.status(400).json({ error: 'libro inválido' });
        }
        if (mode !== 'version' && mode !== 'note') {
            return res.status(400).json({ error: 'modo inválido (version|note)' });
        }

        if (mode === 'version') {
            if (kind !== 'book' && kind !== 'audio') {
                return res.status(400).json({ error: 'formato inválido (book|audio)' });
            }
            if (!LANGUAGE_SLUGS.has(language)) {
                return res.status(400).json({ error: 'idioma inválido' });
            }
        } else {
            // En modo "note", el texto es lo único que importa.
            if (!notes || notes.length < 5) {
                return res.status(400).json({ error: 'la observación es muy corta' });
            }
        }

        try {
            const [bookRows] = await pool.query(
                `SELECT b.id, b.title, b.author, b.year, c.slug AS category_slug
                   FROM books b
                   JOIN categories c ON c.id = b.category_id
                  WHERE b.id = ? LIMIT 1`,
                [bookId]
            );
            if (bookRows.length === 0) {
                return res.status(404).json({ error: 'libro no encontrado' });
            }
            const parent = bookRows[0];

            // Llenamos idioma/links sólo si es modo "version"; en "note" todo
            // queda null y la contribution lleva exclusivamente las notas.
            const langsBook  = (mode === 'version' && kind === 'book')  ? language : null;
            const langsAudio = (mode === 'version' && kind === 'audio') ? language : null;
            const linksBook  = (mode === 'version' && kind === 'book'  && url)
                ? JSON.stringify({ [language]: url }) : null;
            const linksAudio = (mode === 'version' && kind === 'audio' && url)
                ? JSON.stringify({ [language]: url }) : null;

            const tag = mode === 'note'
                ? '[observación / corrección]'
                : '[aporte de versión/idioma]';
            const composedNotes = notes
                ? `${tag} ${notes}`
                : `${tag} ${kind === 'book' ? 'libro' : 'audiolibro'} en ${language}`;

            const [result] = await pool.query(
                `INSERT INTO contributions
                   (title, author, category_slug, year,
                    notes,
                    languages_book, languages_audio,
                    links_book, links_audio,
                    parent_book_id)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [parent.title, parent.author, parent.category_slug, parent.year,
                 composedNotes,
                 langsBook, langsAudio,
                 linksBook, linksAudio,
                 parent.id]
            );
            res.status(201).json({ ok: true, id: result.insertId });
        } catch (err) {
            console.error('[contributions/version]', err);
            res.status(500).json({ error: 'no se pudo guardar el aporte' });
        }
    });

    // -------------------------------------------------------------------------
    // Panel de administración (oculto)
    // -------------------------------------------------------------------------

    // Login: valida usuario/contraseña y devuelve cookie firmada
    app.post('/api/admin/login', (req, res) => {
        const user = String(req.body && req.body.user || '');
        const pass = String(req.body && req.body.password || '');

        // Comparación en tiempo constante (hash → buffers de igual largo)
        const sha = (s) => crypto.createHash('sha256').update(s).digest();
        const userOk = crypto.timingSafeEqual(sha(user), sha(ADMIN_USER));
        const passOk = crypto.timingSafeEqual(sha(pass), sha(ADMIN_PASSWORD));

        if (!userOk || !passOk) {
            return res.status(401).json({ error: 'credenciales inválidas' });
        }

        const exp = Date.now() + SESSION_MS;
        const token = signToken({ user: ADMIN_USER, exp });
        const isProd = process.env.NODE_ENV === 'production';
        const parts = [
            `${COOKIE_NAME}=${encodeURIComponent(token)}`,
            'Path=/',
            'HttpOnly',
            'SameSite=Strict',
            `Max-Age=${Math.floor(SESSION_MS / 1000)}`,
        ];
        if (isProd) parts.push('Secure');
        res.setHeader('Set-Cookie', parts.join('; '));
        res.json({ ok: true, user: ADMIN_USER });
    });

    // Logout: borra la cookie
    app.post('/api/admin/logout', (_req, res) => {
        res.setHeader(
            'Set-Cookie',
            `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`
        );
        res.json({ ok: true });
    });

    // Estado de sesión actual
    app.get('/api/admin/me', (req, res) => {
        const cookies = parseCookies(req);
        const session = verifyToken(cookies[COOKIE_NAME]);
        if (!session || session.user !== ADMIN_USER) {
            return res.status(401).json({ authenticated: false });
        }
        res.json({ authenticated: true, user: session.user, exp: session.exp });
    });

    // Alta directa de un libro desde el panel (no pasa por la cola de aportes).
    // Acepta multipart/form-data idéntico al de /api/contributions, más un
    // campo `section` (A–F). El admin elige la sección a mano.
    app.post(
        '/api/admin/books',
        requireAdmin,
        (req, res, next) => {
            coverUpload.single('cover')(req, res, (err) => {
                if (err) {
                    if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
                        return res.status(413).json({ error: 'la portada supera 5 MB' });
                    }
                    return res.status(400).json({ error: err.message || 'archivo inválido' });
                }
                next();
            });
        },
        async (req, res) => {
            const body = req.body || {};
            const title    = String(body.title    || '').trim();
            const author   = String(body.author   || '').trim();
            const section  = String(body.section  || '').trim().toUpperCase();
            const year     = String(body.year     || '').trim().slice(0, 20) || null;
            const linkPdf   = String(body.link_pdf  || '').trim().slice(0, 500) || null;
            const linkEpub  = String(body.link_epub || '').trim().slice(0, 500) || null;
            const linkAudio = String(body.link_audio|| '').trim().slice(0, 500) || null;
            const fragment  = String(body.fragment  || '').trim().slice(0, 6000) || null;
            const langsBook  = normalizeLanguages(body.languages_book);
            const langsAudio = normalizeLanguages(body.languages_audio);
            const linksBook  = parseLinksJson(body.links_book_json);
            const linksAudio = parseLinksJson(body.links_audio_json);

            if (!title || title.length > 200) {
                cleanupCover(req.file);
                return res.status(400).json({ error: 'título inválido' });
            }
            if (!author || author.length > 150) {
                cleanupCover(req.file);
                return res.status(400).json({ error: 'autor inválido' });
            }
            if (!/^[A-F]$/.test(section)) {
                cleanupCover(req.file);
                return res.status(400).json({ error: 'sección inválida (A–F)' });
            }
            // La categoría se deriva 1:1 desde la sección — el form ya no la
            // pide. Mantenemos la columna books.category_id por compat con el
            // esquema, pero no es una entrada del usuario.
            const catSlug = SECTION_TO_CATEGORY_SLUG[section];

            try {
                const [catRows] = await pool.query(
                    'SELECT id FROM categories WHERE slug = ? LIMIT 1', [catSlug]
                );
                if (catRows.length === 0) {
                    cleanupCover(req.file);
                    return res.status(400).json({ error: 'sección sin categoría asociada' });
                }
                const categoryId = catRows[0].id;

                const coverWebPath = req.file
                    ? `/uploads/covers/${req.file.filename}`
                    : null;

                const [result] = await pool.query(
                    `INSERT INTO books
                       (title, author, year, category_id, section,
                        cover_path, fragment,
                        link_pdf, link_epub, link_audio,
                        languages_book, languages_audio,
                        links_book, links_audio)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    [title, author, year, categoryId, section,
                     coverWebPath, fragment,
                     linkPdf, linkEpub, linkAudio,
                     langsBook, langsAudio,
                     linksBook, linksAudio]
                );
                res.status(201).json({ ok: true, id: result.insertId });
            } catch (err) {
                console.error('[admin/books:create]', err);
                cleanupCover(req.file);
                res.status(500).json({ error: 'no se pudo crear el libro' });
            }
        }
    );

    // -------------------------------------------------------------------------
    // Editar un libro existente (protegido). Mismo formato multipart que el POST,
    // con la salvedad de que el cover sólo se reemplaza si llega un archivo nuevo.
    // -------------------------------------------------------------------------
    app.put(
        '/api/admin/books/:id',
        requireAdmin,
        (req, res, next) => {
            coverUpload.single('cover')(req, res, (err) => {
                if (err) {
                    if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
                        return res.status(413).json({ error: 'la portada supera 5 MB' });
                    }
                    return res.status(400).json({ error: err.message || 'archivo inválido' });
                }
                next();
            });
        },
        async (req, res) => {
            const id = Number.parseInt(req.params.id, 10);
            if (!Number.isFinite(id) || id <= 0) {
                cleanupCover(req.file);
                return res.status(400).json({ error: 'id inválido' });
            }

            const body = req.body || {};
            const title    = String(body.title    || '').trim();
            const author   = String(body.author   || '').trim();
            const section  = String(body.section  || '').trim().toUpperCase();
            const year     = String(body.year     || '').trim().slice(0, 20) || null;
            const linkPdf   = String(body.link_pdf  || '').trim().slice(0, 500) || null;
            const linkEpub  = String(body.link_epub || '').trim().slice(0, 500) || null;
            const linkAudio = String(body.link_audio|| '').trim().slice(0, 500) || null;
            const fragment  = String(body.fragment  || '').trim().slice(0, 6000) || null;
            const langsBook  = normalizeLanguages(body.languages_book);
            const langsAudio = normalizeLanguages(body.languages_audio);
            const linksBook  = parseLinksJson(body.links_book_json);
            const linksAudio = parseLinksJson(body.links_audio_json);
            const clearCover = String(body.cover_clear || '') === '1';

            if (!title || title.length > 200) {
                cleanupCover(req.file);
                return res.status(400).json({ error: 'título inválido' });
            }
            if (!author || author.length > 150) {
                cleanupCover(req.file);
                return res.status(400).json({ error: 'autor inválido' });
            }
            if (!/^[A-F]$/.test(section)) {
                cleanupCover(req.file);
                return res.status(400).json({ error: 'sección inválida (A–F)' });
            }
            // La categoría se deriva 1:1 desde la sección.
            const catSlug = SECTION_TO_CATEGORY_SLUG[section];

            try {
                const [catRows] = await pool.query(
                    'SELECT id FROM categories WHERE slug = ? LIMIT 1', [catSlug]
                );
                if (catRows.length === 0) {
                    cleanupCover(req.file);
                    return res.status(400).json({ error: 'sección sin categoría asociada' });
                }
                const categoryId = catRows[0].id;

                const [existing] = await pool.query(
                    'SELECT cover_path FROM books WHERE id = ? LIMIT 1', [id]
                );
                if (existing.length === 0) {
                    cleanupCover(req.file);
                    return res.status(404).json({ error: 'libro no encontrado' });
                }
                const oldCover = existing[0].cover_path;

                let newCoverPath = oldCover;
                if (req.file) {
                    newCoverPath = `/uploads/covers/${req.file.filename}`;
                } else if (clearCover) {
                    newCoverPath = null;
                }

                await pool.query(
                    `UPDATE books
                        SET title = ?, author = ?, year = ?, category_id = ?, section = ?,
                            cover_path = ?, fragment = ?,
                            link_pdf = ?, link_epub = ?, link_audio = ?,
                            languages_book = ?, languages_audio = ?,
                            links_book = ?, links_audio = ?
                      WHERE id = ?`,
                    [title, author, year, categoryId, section,
                     newCoverPath, fragment,
                     linkPdf, linkEpub, linkAudio,
                     langsBook, langsAudio,
                     linksBook, linksAudio,
                     id]
                );

                if (oldCover && oldCover !== newCoverPath) {
                    cleanupCoverByWebPath(oldCover);
                }

                res.json({ ok: true, id });
            } catch (err) {
                console.error('[admin/books:update]', err);
                cleanupCover(req.file);
                res.status(500).json({ error: 'no se pudo actualizar el libro' });
            }
        }
    );

    // -------------------------------------------------------------------------
    // Editar un aporte pendiente (protegido).
    // -------------------------------------------------------------------------
    app.put(
        '/api/admin/contributions/:id',
        requireAdmin,
        (req, res, next) => {
            coverUpload.single('cover')(req, res, (err) => {
                if (err) {
                    if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
                        return res.status(413).json({ error: 'la portada supera 5 MB' });
                    }
                    return res.status(400).json({ error: err.message || 'archivo inválido' });
                }
                next();
            });
        },
        async (req, res) => {
            const id = Number.parseInt(req.params.id, 10);
            if (!Number.isFinite(id) || id <= 0) {
                cleanupCover(req.file);
                return res.status(400).json({ error: 'id inválido' });
            }

            const body = req.body || {};
            const title    = String(body.title    || '').trim();
            const author   = String(body.author   || '').trim();
            const sectionRaw = String(body.section || '').trim().toUpperCase();
            let catSlug    = String(body.category || '').trim().toLowerCase();
            const year     = String(body.year     || '').trim().slice(0, 20) || null;
            const linkPdf   = String(body.link_pdf  || '').trim().slice(0, 500) || null;
            const linkEpub  = String(body.link_epub || '').trim().slice(0, 500) || null;
            const linkAudio = String(body.link_audio|| '').trim().slice(0, 500) || null;
            const fragment  = String(body.fragment  || '').trim().slice(0, 6000) || null;
            const notes     = String(body.notes     || '').trim().slice(0, 1000) || null;
            const langsBook  = normalizeLanguages(body.languages_book);
            const langsAudio = normalizeLanguages(body.languages_audio);
            const linksBook  = parseLinksJson(body.links_book_json);
            const linksAudio = parseLinksJson(body.links_audio_json);
            const clearCover = String(body.cover_clear || '') === '1';

            if (!title || title.length > 200) {
                cleanupCover(req.file);
                return res.status(400).json({ error: 'título inválido' });
            }
            if (!author || author.length > 150) {
                cleanupCover(req.file);
                return res.status(400).json({ error: 'autor inválido' });
            }
            if (sectionRaw) {
                if (!ALLOWED_SECTIONS.has(sectionRaw)) {
                    cleanupCover(req.file);
                    return res.status(400).json({ error: 'sección inválida' });
                }
                catSlug = SECTION_TO_CATEGORY_SLUG[sectionRaw];
            }

            try {
                if (catSlug) {
                    const [catRows] = await pool.query(
                        'SELECT id FROM categories WHERE slug = ? LIMIT 1', [catSlug]
                    );
                    if (catRows.length === 0) {
                        cleanupCover(req.file);
                        return res.status(400).json({ error: 'sección desconocida' });
                    }
                }

                const [existing] = await pool.query(
                    'SELECT cover_path, status, category_slug FROM contributions WHERE id = ? LIMIT 1', [id]
                );
                if (existing.length === 0) {
                    cleanupCover(req.file);
                    return res.status(404).json({ error: 'aporte no encontrado' });
                }
                if (existing[0].status !== 'pending') {
                    cleanupCover(req.file);
                    return res.status(409).json({ error: 'sólo se pueden editar aportes pendientes' });
                }
                const oldCover = existing[0].cover_path;
                const finalCatSlug = catSlug || existing[0].category_slug;

                let newCoverPath = oldCover;
                if (req.file) {
                    newCoverPath = `/uploads/covers/${req.file.filename}`;
                } else if (clearCover) {
                    newCoverPath = null;
                }

                await pool.query(
                    `UPDATE contributions
                        SET title = ?, author = ?, category_slug = ?, year = ?,
                            link_pdf = ?, link_epub = ?, link_audio = ?,
                            fragment = ?, notes = ?, cover_path = ?,
                            languages_book = ?, languages_audio = ?,
                            links_book = ?, links_audio = ?
                      WHERE id = ?`,
                    [title, author, finalCatSlug, year,
                     linkPdf, linkEpub, linkAudio,
                     fragment, notes, newCoverPath,
                     langsBook, langsAudio,
                     linksBook, linksAudio,
                     id]
                );

                if (oldCover && oldCover !== newCoverPath) {
                    cleanupCoverByWebPath(oldCover);
                }

                res.json({ ok: true, id });
            } catch (err) {
                console.error('[admin/contributions:update]', err);
                cleanupCover(req.file);
                res.status(500).json({ error: 'no se pudo actualizar el aporte' });
            }
        }
    );

    // Listado completo de libros (protegido)
    app.get('/api/admin/books', requireAdmin, async (_req, res) => {
        try {
            const [rows] = await pool.query(`
                SELECT b.id,
                       b.title,
                       b.author,
                       b.section,
                       c.slug  AS category_slug,
                       c.name  AS category_name
                FROM books b
                JOIN categories c ON c.id = b.category_id
                ORDER BY b.id ASC
            `);
            res.json(rows);
        } catch (err) {
            console.error('[admin/books]', err);
            res.status(500).json({ error: 'no se pudo obtener el listado' });
        }
    });

    // Listado de aportes pendientes / decididos (protegido)
    app.get('/api/admin/contributions', requireAdmin, async (req, res) => {
        const status = String(req.query.status || 'pending');
        const parent = String(req.query.parent || 'all');
        const allowedStatus = new Set(['pending', 'accepted', 'rejected', 'all']);
        const allowedParent = new Set(['new', 'existing', 'all']);
        if (!allowedStatus.has(status)) return res.status(400).json({ error: 'status inválido' });
        if (!allowedParent.has(parent)) return res.status(400).json({ error: 'parent inválido' });
        try {
            const clauses = [];
            const params  = [];
            if (status !== 'all') { clauses.push('c.status = ?'); params.push(status); }
            if (parent === 'new')      clauses.push('c.parent_book_id IS NULL');
            if (parent === 'existing') clauses.push('c.parent_book_id IS NOT NULL');
            const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';
            const [rows] = await pool.query(
                `SELECT c.id, c.title, c.author, c.category_slug,
                        c.year, c.link_pdf, c.link_epub, c.link_audio,
                        c.links_book, c.links_audio,
                        c.fragment, c.notes,
                        c.cover_path, c.languages_book, c.languages_audio,
                        c.status, c.book_id, c.parent_book_id,
                        c.created_at, c.decided_at,
                        cat.name AS category_name,
                        pb.title  AS parent_book_title,
                        pb.author AS parent_book_author
                 FROM contributions c
                 LEFT JOIN categories cat ON cat.slug = c.category_slug
                 LEFT JOIN books pb        ON pb.id   = c.parent_book_id
                 ${where}
                 ORDER BY c.created_at DESC`,
                params
            );
            res.json(rows);
        } catch (err) {
            console.error('[admin/contributions]', err);
            res.status(500).json({ error: 'no se pudo obtener la cola' });
        }
    });

    app.get('/api/admin/contributions/count', requireAdmin, async (_req, res) => {
        try {
            const [rows] = await pool.query(
                `SELECT
                     SUM(parent_book_id IS NULL)     AS new_count,
                     SUM(parent_book_id IS NOT NULL) AS existing_count,
                     COUNT(*)                        AS total
                   FROM contributions
                  WHERE status = 'pending'`
            );
            const r = rows[0] || {};
            res.json({
                pending:          Number(r.total          || 0),
                pending_new:      Number(r.new_count      || 0),
                pending_existing: Number(r.existing_count || 0)
            });
        } catch (err) {
            console.error('[admin/contributions/count]', err);
            res.status(500).json({ error: 'no se pudo contar' });
        }
    });

    function mergeLanguageCsv(a, b) {
        const seen = new Set();
        const out  = [];
        const push = (raw) => {
            if (!raw) return;
            String(raw).split(',').forEach(p => {
                const slug = p.trim().toLowerCase();
                if (slug && !seen.has(slug) && LANGUAGE_SLUGS.has(slug)) {
                    seen.add(slug);
                    out.push(slug);
                }
            });
        };
        push(a);
        push(b);
        return out.length ? out.join(',') : null;
    }

    function mergeLinksMap(a, b) {
        const parse = (v) => {
            if (!v) return {};
            if (typeof v === 'object') return v;
            try { return JSON.parse(String(v)) || {}; } catch (_) { return {}; }
        };
        const merged = { ...parse(a), ...parse(b) };
        const out = {};
        Object.keys(merged).forEach(k => {
            const slug = String(k || '').trim().toLowerCase();
            const url  = String(merged[k] || '').trim().slice(0, 500);
            if (slug && url && LANGUAGE_SLUGS.has(slug)) out[slug] = url;
        });
        return Object.keys(out).length ? JSON.stringify(out) : null;
    }

    app.post('/api/admin/contributions/:id/accept', requireAdmin, async (req, res) => {
        const id = Number.parseInt(req.params.id, 10);
        if (!Number.isFinite(id) || id <= 0) {
            return res.status(400).json({ error: 'id inválido' });
        }

        const conn = await pool.getConnection();
        try {
            await conn.beginTransaction();

            const [rows] = await conn.query(
                `SELECT c.id, c.title, c.author, c.category_slug, c.status,
                        c.year, c.link_pdf, c.link_epub, c.link_audio,
                        c.fragment, c.cover_path,
                        c.languages_book, c.languages_audio,
                        c.links_book, c.links_audio,
                        c.parent_book_id,
                        cat.id AS category_id
                 FROM contributions c
                 LEFT JOIN categories cat ON cat.slug = c.category_slug
                 WHERE c.id = ? FOR UPDATE`,
                [id]
            );
            if (rows.length === 0) {
                await conn.rollback();
                return res.status(404).json({ error: 'aporte no encontrado' });
            }
            const c = rows[0];
            if (c.status !== 'pending') {
                await conn.rollback();
                return res.status(409).json({ error: `el aporte ya está ${c.status}` });
            }

            if (c.parent_book_id) {
                const [parentRows] = await conn.query(
                    `SELECT id, languages_book, languages_audio,
                            links_book, links_audio
                       FROM books WHERE id = ? FOR UPDATE`,
                    [c.parent_book_id]
                );
                if (parentRows.length === 0) {
                    await conn.rollback();
                    return res.status(404).json({ error: 'libro padre no encontrado' });
                }
                const parent = parentRows[0];

                const mergedLangsBook  = mergeLanguageCsv(parent.languages_book,  c.languages_book);
                const mergedLangsAudio = mergeLanguageCsv(parent.languages_audio, c.languages_audio);
                const mergedLinksBook  = mergeLinksMap(parent.links_book,  c.links_book);
                const mergedLinksAudio = mergeLinksMap(parent.links_audio, c.links_audio);

                await conn.query(
                    `UPDATE books
                        SET languages_book  = ?,
                            languages_audio = ?,
                            links_book      = ?,
                            links_audio     = ?
                      WHERE id = ?`,
                    [mergedLangsBook, mergedLangsAudio,
                     mergedLinksBook, mergedLinksAudio,
                     parent.id]
                );

                await conn.query(
                    `UPDATE contributions
                        SET status = 'accepted',
                            book_id = ?,
                            decided_at = NOW()
                      WHERE id = ?`,
                    [parent.id, id]
                );

                await conn.commit();
                return res.json({ ok: true, book_id: parent.id, merged: true });
            }

            if (!c.category_id) {
                await conn.rollback();
                return res.status(400).json({ error: 'sección inexistente, no se puede aceptar' });
            }
            const section = CATEGORY_TO_SECTION[c.category_slug] || 'A';

            const linksBookJson  = c.links_book  ? JSON.stringify(c.links_book)  : null;
            const linksAudioJson = c.links_audio ? JSON.stringify(c.links_audio) : null;

            const [insertResult] = await conn.query(
                `INSERT INTO books
                   (title, author, year, category_id, section,
                    cover_path, fragment,
                    link_pdf, link_epub, link_audio,
                    languages_book, languages_audio,
                    links_book, links_audio)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [c.title, c.author, c.year, c.category_id, section,
                 c.cover_path, c.fragment,
                 c.link_pdf, c.link_epub, c.link_audio,
                 c.languages_book, c.languages_audio,
                 linksBookJson, linksAudioJson]
            );
            const newBookId = insertResult.insertId;

            await conn.query(
                `UPDATE contributions
                    SET status = 'accepted',
                        book_id = ?,
                        decided_at = NOW()
                  WHERE id = ?`,
                [newBookId, id]
            );

            await conn.commit();
            res.json({ ok: true, book_id: newBookId });
        } catch (err) {
            await conn.rollback();
            console.error('[admin/accept]', err);
            res.status(500).json({ error: 'no se pudo aceptar el aporte' });
        } finally {
            conn.release();
        }
    });

    app.post('/api/admin/contributions/:id/reject', requireAdmin, async (req, res) => {
        const id = Number.parseInt(req.params.id, 10);
        if (!Number.isFinite(id) || id <= 0) {
            return res.status(400).json({ error: 'id inválido' });
        }
        try {
            const [result] = await pool.query(
                `UPDATE contributions
                    SET status = 'rejected', decided_at = NOW()
                  WHERE id = ? AND status = 'pending'`,
                [id]
            );
            if (result.affectedRows === 0) {
                return res.status(409).json({ error: 'el aporte no estaba pendiente' });
            }
            res.json({ ok: true });
        } catch (err) {
            console.error('[admin/reject]', err);
            res.status(500).json({ error: 'no se pudo rechazar' });
        }
    });

    // -------------------------------------------------------------------------
    // Reportes de enlace caído
    // -------------------------------------------------------------------------
    app.get('/api/admin/reports/count', requireAdmin, async (_req, res) => {
        try {
            const [rows] = await pool.query(
                "SELECT COUNT(*) AS n FROM reports WHERE status = 'pending'"
            );
            res.json({ pending: Number(rows[0]?.n || 0) });
        } catch (err) {
            console.error('[admin/reports/count]', err);
            res.status(500).json({ error: 'no se pudo contar' });
        }
    });

    app.get('/api/admin/reports', requireAdmin, async (req, res) => {
        const status = String(req.query.status || 'pending');
        const allowed = new Set(['pending', 'resolved', 'dismissed', 'all']);
        const filter = allowed.has(status) ? status : 'pending';
        const where  = filter === 'all' ? '' : 'WHERE r.status = ?';
        const params = filter === 'all' ? [] : [filter];
        try {
            const [rows] = await pool.query(
                `SELECT r.id, r.book_id, r.message, r.status,
                        r.created_at, r.decided_at,
                        b.title  AS book_title,
                        b.author AS book_author
                   FROM reports r
                   LEFT JOIN books b ON b.id = r.book_id
                   ${where}
                   ORDER BY r.created_at DESC`,
                params
            );
            res.json(rows);
        } catch (err) {
            console.error('[admin/reports]', err);
            res.status(500).json({ error: 'no se pudieron cargar los reportes' });
        }
    });

    function makeReportDecisionHandler(targetStatus, errorTag) {
        return async (req, res) => {
            const id = Number.parseInt(req.params.id, 10);
            if (!Number.isFinite(id) || id <= 0) {
                return res.status(400).json({ error: 'id inválido' });
            }
            try {
                const [result] = await pool.query(
                    `UPDATE reports
                        SET status = ?, decided_at = NOW()
                      WHERE id = ? AND status = 'pending'`,
                    [targetStatus, id]
                );
                if (result.affectedRows === 0) {
                    return res.status(409).json({ error: 'el reporte no estaba pendiente' });
                }
                res.json({ ok: true });
            } catch (err) {
                console.error(errorTag, err);
                res.status(500).json({ error: 'no se pudo actualizar el reporte' });
            }
        };
    }

    app.post('/api/admin/reports/:id/resolve',
        requireAdmin, makeReportDecisionHandler('resolved',  '[admin/report-resolve]'));
    app.post('/api/admin/reports/:id/dismiss',
        requireAdmin, makeReportDecisionHandler('dismissed', '[admin/report-dismiss]'));

    app.get('/admin', (_req, res) => {
        res.sendFile(path.join(__dirname, 'public', 'admin.html'));
    });

    app.get(/^\/(?!api\/).*/, (_req, res) => {
        res.sendFile(path.join(__dirname, 'public', 'index.html'));
    });

    app.listen(PORT, () => {
        // PUBLIC_URL apunta al host real al que se accede desde afuera del
        // contenedor (publicado en el docker-compose). Si no está seteado,
        // mostramos el puerto interno como fallback (caso dev sin docker).
        const publicUrl = process.env.PUBLIC_URL || `http://localhost:${PORT}`;
        console.log(`[web] Biblioteca Orden Nacional escuchando en ${publicUrl}`);
    });
}

main().catch(err => {
    console.error('[fatal]', err);
    process.exit(1);
});
