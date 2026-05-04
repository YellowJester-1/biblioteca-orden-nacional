-- =============================================================================
-- Biblioteca Orden Nacional — esquema inicial
-- =============================================================================
-- Este archivo se ejecuta automáticamente la primera vez que se crea el
-- contenedor de MySQL (via /docker-entrypoint-initdb.d/).
-- =============================================================================

SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;

-- ---------- Categorías ----------
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
-- Datos iniciales
-- =============================================================================

INSERT INTO categories (slug, name) VALUES
    ('novela',   'novela'),
    ('cuento',   'cuento'),
    ('poesia',   'poesía'),
    ('ensayo',   'ensayo'),
    ('historia', 'historia'),
    ('teatro',   'teatro');

-- Sección A — narrativa extensa (novela)
INSERT INTO books (title, author, category_id, section) VALUES
    ('Harassment Architecture',              'Mike Ma',           (SELECT id FROM categories WHERE slug='novela'), 'A'),
    ('Gothic Violence',                      'Mike Ma',           (SELECT id FROM categories WHERE slug='novela'), 'A'),
    ('Ice Front',                            'Mike Ma',           (SELECT id FROM categories WHERE slug='novela'), 'A'),
    ('Confesiones de una máscara',           'Yukio Mishima',     (SELECT id FROM categories WHERE slug='novela'), 'A'),
    ('El pabellón de oro',                   'Yukio Mishima',     (SELECT id FROM categories WHERE slug='novela'), 'A'),
    ('El marino que perdió la gracia del mar','Yukio Mishima',    (SELECT id FROM categories WHERE slug='novela'), 'A'),
    ('Nieve de primavera',                   'Yukio Mishima',     (SELECT id FROM categories WHERE slug='novela'), 'A'),
    ('Sobre los acantilados de mármol',      'Ernst Jünger',      (SELECT id FROM categories WHERE slug='novela'), 'A'),
    ('Eumeswil',                             'Ernst Jünger',      (SELECT id FROM categories WHERE slug='novela'), 'A'),
    ('Heliópolis',                           'Ernst Jünger',      (SELECT id FROM categories WHERE slug='novela'), 'A');

-- Sección B — relato breve (cuento)
INSERT INTO books (title, author, category_id, section) VALUES
    ('Patriotismo',                          'Yukio Mishima',     (SELECT id FROM categories WHERE slug='cuento'), 'B'),
    ('La muerte en pleno verano',            'Yukio Mishima',     (SELECT id FROM categories WHERE slug='cuento'), 'B'),
    ('El corazón aventurero',                'Ernst Jünger',      (SELECT id FROM categories WHERE slug='cuento'), 'B'),
    ('Visita a Godenholm',                   'Ernst Jünger',      (SELECT id FROM categories WHERE slug='cuento'), 'B');

-- Sección C — poesía
INSERT INTO books (title, author, category_id, section) VALUES
    ('Cantos',                               'Ezra Pound',        (SELECT id FROM categories WHERE slug='poesia'), 'C'),
    ('Cathay',                               'Ezra Pound',        (SELECT id FROM categories WHERE slug='poesia'), 'C'),
    ('Hugh Selwyn Mauberley',                'Ezra Pound',        (SELECT id FROM categories WHERE slug='poesia'), 'C'),
    ('Personae',                             'Ezra Pound',        (SELECT id FROM categories WHERE slug='poesia'), 'C'),
    ('ABC de la lectura',                    'Ezra Pound',        (SELECT id FROM categories WHERE slug='poesia'), 'C');

-- Sección D — ensayo y pensamiento
INSERT INTO books (title, author, category_id, section) VALUES
    ('Rebelión contra el mundo moderno',     'Julius Evola',      (SELECT id FROM categories WHERE slug='ensayo'), 'D'),
    ('Los hombres y las ruinas',             'Julius Evola',      (SELECT id FROM categories WHERE slug='ensayo'), 'D'),
    ('Cabalgar el tigre',                    'Julius Evola',      (SELECT id FROM categories WHERE slug='ensayo'), 'D'),
    ('La doctrina del despertar',            'Julius Evola',      (SELECT id FROM categories WHERE slug='ensayo'), 'D'),
    ('Metafísica del sexo',                  'Julius Evola',      (SELECT id FROM categories WHERE slug='ensayo'), 'D'),
    ('El misterio del Grial',                'Julius Evola',      (SELECT id FROM categories WHERE slug='ensayo'), 'D'),
    ('Orientaciones',                        'Julius Evola',      (SELECT id FROM categories WHERE slug='ensayo'), 'D'),
    ('Fanged Noumena',                       'Nick Land',         (SELECT id FROM categories WHERE slug='ensayo'), 'D'),
    ('Colapso',                              'Nick Land',         (SELECT id FROM categories WHERE slug='ensayo'), 'D'),
    ('El sombrío iluminismo',                'Nick Land',         (SELECT id FROM categories WHERE slug='ensayo'), 'D'),
    ('La decadencia de Occidente',           'Oswald Spengler',   (SELECT id FROM categories WHERE slug='ensayo'), 'D'),
    ('El hombre y la técnica',               'Oswald Spengler',   (SELECT id FROM categories WHERE slug='ensayo'), 'D'),
    ('El concepto de lo político',           'Carl Schmitt',      (SELECT id FROM categories WHERE slug='ensayo'), 'D'),
    ('Teología política',                    'Carl Schmitt',      (SELECT id FROM categories WHERE slug='ensayo'), 'D'),
    ('Tierra y mar',                         'Carl Schmitt',      (SELECT id FROM categories WHERE slug='ensayo'), 'D'),
    ('El trabajador',                        'Ernst Jünger',      (SELECT id FROM categories WHERE slug='ensayo'), 'D'),
    ('La emboscadura',                       'Ernst Jünger',      (SELECT id FROM categories WHERE slug='ensayo'), 'D'),
    ('Bronze Age Mindset',                   'Bronze Age Pervert',(SELECT id FROM categories WHERE slug='ensayo'), 'D');

-- Sección E — historia y no ficción
INSERT INTO books (title, author, category_id, section) VALUES
    ('Campaña de Rusia',                     'Léon Degrelle',     (SELECT id FROM categories WHERE slug='historia'), 'E'),
    ('Almas ardientes',                      'Léon Degrelle',     (SELECT id FROM categories WHERE slug='historia'), 'E'),
    ('Hitler, nacido en Versalles',          'Léon Degrelle',     (SELECT id FROM categories WHERE slug='historia'), 'E'),
    ('Hitler demócrata',                     'Léon Degrelle',     (SELECT id FROM categories WHERE slug='historia'), 'E'),
    ('Hitler por mil años',                  'Léon Degrelle',     (SELECT id FROM categories WHERE slug='historia'), 'E'),
    ('Tempestades de acero',                 'Ernst Jünger',      (SELECT id FROM categories WHERE slug='historia'), 'E'),
    ('Radiaciones',                          'Ernst Jünger',      (SELECT id FROM categories WHERE slug='historia'), 'E'),
    ('Sol y acero',                          'Yukio Mishima',     (SELECT id FROM categories WHERE slug='historia'), 'E');

-- Sección F — teatro
INSERT INTO books (title, author, category_id, section) VALUES
    ('Madame de Sade',                       'Yukio Mishima',     (SELECT id FROM categories WHERE slug='teatro'), 'F'),
    ('Mi amigo Hitler',                      'Yukio Mishima',     (SELECT id FROM categories WHERE slug='teatro'), 'F'),
    ('Cinco nō modernos',                    'Yukio Mishima',     (SELECT id FROM categories WHERE slug='teatro'), 'F');
