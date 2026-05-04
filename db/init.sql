-- =============================================================================
-- Biblioteca Orden Nacional — esquema inicial
-- =============================================================================
-- Este archivo se ejecuta automáticamente la primera vez que se crea el
-- contenedor de MySQL (via /docker-entrypoint-initdb.d/).
--
-- Carga el esquema y las categorías base (necesarias para que el FK de
-- books.category_id pueda satisfacerse). El catálogo de libros queda vacío:
-- los libros se cargan después desde el panel /admin o vía aportes públicos.
-- =============================================================================

SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;

-- ---------- Tablas ----------
DROP TABLE IF EXISTS reports;
DROP TABLE IF EXISTS books;
DROP TABLE IF EXISTS categories;

CREATE TABLE categories (
    id          INT AUTO_INCREMENT PRIMARY KEY,
    slug        VARCHAR(40)  NOT NULL UNIQUE,
    name        VARCHAR(80)  NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE books (
    id           INT AUTO_INCREMENT PRIMARY KEY,
    title        VARCHAR(200) NOT NULL,
    author       VARCHAR(150) NOT NULL,
    category_id  INT          NOT NULL,
    section      CHAR(1)      NOT NULL,
    CONSTRAINT fk_books_category
        FOREIGN KEY (category_id) REFERENCES categories(id)
        ON DELETE RESTRICT ON UPDATE CASCADE,
    INDEX idx_books_section  (section),
    INDEX idx_books_title    (title),
    INDEX idx_books_author   (author)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE reports (
    id         INT AUTO_INCREMENT PRIMARY KEY,
    book_id    INT NULL,
    message    TEXT NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_reports_book (book_id),
    CONSTRAINT fk_reports_book
        FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

SET FOREIGN_KEY_CHECKS = 1;

-- =============================================================================
-- Categorías base
-- =============================================================================
-- Mapean 1:1 con las secciones (A → novela, B → cuento, C → poesía,
-- D → ensayo, E → historia, F → teatro). El backend deriva la categoría
-- desde la letra de sección al cargar un libro.
-- =============================================================================

INSERT INTO categories (slug, name) VALUES
    ('novela',   'novela'),
    ('cuento',   'cuento'),
    ('poesia',   'poesía'),
    ('ensayo',   'ensayo'),
    ('historia', 'historia'),
    ('teatro',   'teatro');
