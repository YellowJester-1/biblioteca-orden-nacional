-- =============================================================================
-- Biblioteca Orden Nacional — limpieza total del catálogo
-- =============================================================================
-- Vacía libros, aportes y reportes y reinicia los contadores AUTO_INCREMENT.
-- Las categorías y la estructura de tablas se mantienen.
--
-- Ejecutar (con el stack levantado):
--     docker compose exec -T db mysql -uorden -porden biblioteca < db/wipe.sql
-- =============================================================================

SET FOREIGN_KEY_CHECKS = 0;

DELETE FROM reports;
DELETE FROM contributions;
DELETE FROM books;

ALTER TABLE books         AUTO_INCREMENT = 1;
ALTER TABLE contributions AUTO_INCREMENT = 1;
ALTER TABLE reports       AUTO_INCREMENT = 1;

SET FOREIGN_KEY_CHECKS = 1;

-- Verificación
SELECT 'books'         AS tabla, COUNT(*) AS filas FROM books
UNION ALL
SELECT 'contributions' AS tabla, COUNT(*) AS filas FROM contributions
UNION ALL
SELECT 'reports'       AS tabla, COUNT(*) AS filas FROM reports;
