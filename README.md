# Biblioteca Orden Nacional

Catálogo web auto-hospedado para indexar libros, audiolibros y enlaces a obras alojadas en otros sitios. La aplicación funciona como un catálogo: organiza, describe y enlaza obras hospedadas en otros lugares; el servidor del sitio no aloja archivos de libros.

## Tecnologías

- **Node 20** + **Express 4** — servidor HTTP y API REST.
- **MySQL 8** — almacenamiento del catálogo, aportes y reportes.
- **mysql2/promise** — driver con pool de conexiones y transacciones.
- **multer** — recepción de portadas (multipart/form-data) con límite de 5 MB.
- **archiver** — generación on-the-fly de ZIP para exportaciones.
- **pdfkit** — generación on-the-fly de PDF.
- **nodemon** — recarga automática en desarrollo.
- **Docker** + **Docker Compose** — orquestación de los dos servicios (app + db).
- HTML, CSS y JavaScript vanilla en el frontend (sin frameworks ni build step).
- Autenticación de administrador con cookie firmada **HMAC-SHA256** (sin librerías externas de sesión).

## Cómo levantar el sistema

Necesitás tener **Docker Desktop** (Windows / macOS) o **Docker Engine** + **Docker Compose v2** (Linux) instalados.

```bash
docker compose up --build
```

La primera vez tarda un poco: descarga las imágenes, inicializa MySQL y carga el esquema de `db/init.sql`. Cuando en la consola aparezca:

```
[web] Biblioteca Orden Nacional escuchando en http://localhost:4280
```

el sitio está disponible en **http://localhost:4280**. Internamente el contenedor escucha en el puerto 3000 y `docker-compose` lo publica en el 4280 del host.

Para detenerlo:

```bash
docker compose down
```

Para detener y borrar también los datos de MySQL (empezar de cero):

```bash
docker compose down -v
```

### Variables de entorno

El `docker-compose.yml` ya viene con valores por defecto pensados para desarrollo local. Para producción conviene sobreescribir al menos las credenciales de admin y el secret de firma.

| Variable          | Default                     | Descripción                                          |
| ----------------- | --------------------------- | ---------------------------------------------------- |
| `DB_HOST`         | `db`                        | Host de MySQL.                                       |
| `DB_PORT`         | `3306`                      | Puerto de MySQL.                                     |
| `DB_USER`         | `orden`                     | Usuario de la DB.                                    |
| `DB_PASSWORD`     | `orden`                     | Contraseña de la DB.                                 |
| `DB_NAME`         | `biblioteca`                | Nombre de la DB.                                     |
| `PORT`            | `3000`                      | Puerto interno del servidor Node.                    |
| `ADMIN_USER`      | `admin`                     | Usuario para el panel `/admin`.                      |
| `ADMIN_PASSWORD`  | `admin`                     | Contraseña del panel.                                |
| `ADMIN_SECRET`    | `change-me-in-prod-please`  | Clave HMAC para firmar la cookie de sesión de admin. |

> En producción, **cambiá** `ADMIN_USER`, `ADMIN_PASSWORD` y `ADMIN_SECRET`. El servidor imprime una advertencia si detecta que `ADMIN_SECRET` quedó en su valor por defecto.

### Desarrollo sin Docker

Si tenés MySQL corriendo localmente:

```bash
npm install
DB_HOST=localhost DB_USER=orden DB_PASSWORD=orden DB_NAME=biblioteca npm run dev
```

`npm run dev` levanta el servidor con nodemon (reload automático ante cambios).

## Estructura del repositorio

```
proyecto-orden/
├── docker-compose.yml          # orquesta app + db
├── Dockerfile                  # imagen del server Node
├── .dockerignore
├── .gitignore
├── package.json
├── server.js                   # Express + API + auth admin
├── db/
│   └── init.sql                # esquema inicial: categories, books
└── public/
    ├── index.html              # home + listado del catálogo
    ├── section.html            # listado completo de una sección
    ├── book.html               # detalle de un libro
    ├── admin.html              # panel de administración
    ├── styles.css              # estilos compartidos
    ├── theme.js                # toggle de tema claro/oscuro
    └── disclaimer.js           # modal de aviso legal
```

## Funcionalidades

- **Catálogo público** organizado por secciones (A–F): novela, cuento, poesía, ensayo, historia, teatro.
- **Búsqueda** por título o autor en vivo.
- **Vista lista / cuadrícula** con preferencia persistida en `localStorage`.
- **Tema claro / oscuro** con preferencia persistida en `localStorage`.
- **Detalle por libro** con fragmento, idiomas disponibles del libro y del audiolibro, y enlaces de descarga separados por idioma.
- **Aporte público de títulos**: cualquier visitante puede sugerir un libro nuevo o un idioma/versión faltante para uno existente. Los aportes entran a una cola de moderación.
- **Reporte de enlaces caídos** desde el detalle del libro.
- **Panel de administración** en `/admin` (login con usuario/contraseña): alta/edición de libros, moderación de aportes (aceptar/rechazar/editar) y gestión de reportes de enlaces caídos.

## Endpoints principales

### Públicos

- `GET /api/health` — estado del servidor y la DB.
- `GET /api/categories` — listado de categorías.
- `GET /api/languages` — idiomas válidos para libros y audiolibros.
- `GET /api/books` — catálogo completo (con sección y categoría resueltas).
- `GET /api/books/:id` — detalle de un libro.
- `POST /api/contributions` — alta de un aporte público (multipart/form-data).
- `POST /api/contributions/version` — aporte de idioma/versión faltante para un libro existente.
- `POST /api/reports` — reporte de enlace caído.

### Admin (requieren cookie de sesión)

- `POST /api/admin/login` — login con `username` + `password`.
- `POST /api/admin/logout` — cierre de sesión.
- `GET  /api/admin/me` — verifica la sesión activa.
- `POST /api/admin/books`, `PUT /api/admin/books/:id` — alta/edición de libros.
- `GET  /api/admin/books` — listado completo.
- `GET  /api/admin/contributions` — cola de aportes (filtrable por status y por nuevo / existente).
- `PUT  /api/admin/contributions/:id` — editar un aporte pendiente.
- `POST /api/admin/contributions/:id/accept` — aceptar (publica el libro o mergea sobre el padre).
- `POST /api/admin/contributions/:id/reject` — rechazar.
- `GET  /api/admin/reports` — listado de reportes de enlaces caídos.
- `POST /api/admin/reports/:id/resolve|dismiss` — moderación de reportes.

## Privacidad y aviso legal

### Privacidad

Esta aplicación **no recolecta información de los visitantes que no haya sido tipeada por ellos en un formulario**. Concretamente:

- No emite cookies para visitantes anónimos. La única cookie que la app setea (`bon_admin`) se entrega exclusivamente al iniciar sesión en `/admin`.
- No incluye analítica, rastreadores ni pixels de terceros (ni Google Analytics, ni Hotjar, ni Plausible, ni Sentry, ni Facebook Pixel).
- No registra direcciones IP, User-Agent ni headers en logs propios. El servidor sólo escribe a stdout mensajes de inicio de DB y errores de queries.
- No usa sesiones de servidor para visitantes anónimos. No hay tablas de usuarios públicos.
- Las únicas preferencias que persisten son locales del navegador (tema claro/oscuro y modo de vista lista / cuadrícula) en `localStorage` — el servidor no las recibe ni las puede leer.

> Aclaración honesta: a nivel TCP/HTTP, todo servidor recibe la IP del cliente y los headers. La app no los guarda, pero un proxy reverso (nginx, Traefik, Cloudflare) o el log driver de Docker pueden capturar IPs en sus logs de acceso fuera del código de la aplicación. Si querés cero IPs también a nivel infraestructura, configurá explícitamente esos componentes para no loguearlas.

### Catálogo de enlaces

El servidor de este sitio no aloja libros. La Biblioteca Orden Nacional funciona como un catálogo que organiza, describe y enlaza obras hospedadas en otros lugares. La responsabilidad sobre los contenidos enlazados recae sobre quienes los hospedan.

### Criterio de los títulos

Cuando una obra cuenta con traducción establecida al español, su título se registra en español. Si no existe una traducción establecida, el título se conserva en su idioma de origen.
