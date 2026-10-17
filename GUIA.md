# GUIA.md — Cómo funciona la tienda de zapatos (PcuecaSport)

Documento generado al estudiar el código. Sirve para no volver a aprender la página desde cero.

---

## 1. Resumen general

- Tienda SPA (una sola página) sin frameworks: **Node puro en el servidor** + **JavaScript vanilla en el cliente**.
- Única dependencia: **mysql2** (datos y fotos viven en MySQL, por eso el plan gratuito de Render sirve).
- Compra: el cliente elige talla/cantidad y pulsa "Ordenar ahora" → se abre **WhatsApp** (`wa.me`) con el pedido escrito. No hay carrito ni pasarela de pago.
- Panel de administrador con contraseña (`ADMIN_PASSWORD`), sesión por cookie firmada HMAC.
- Marca: "PcuecaSport" (Santa Marta, Colombia). Fuentes Google: *Playball* (logo) y *Plus Jakarta Sans*.

## 2. Estructura de archivos

```
C:\Users\ACER\Desktop\Zapatos\
├── server.js          # Servidor HTTP + API + MySQL (267 líneas, sin dependencias salvo mysql2)
├── package.json       # solo "mysql2"; scripts.start = node server.js; engines node >=18
├── render.yaml        # Blueprint de Render (plan free, env vars)
├── README.md          # Instrucciones de despliegue y respaldo
├── CLAUDE.md          # Reglas del dueño (respuestas cortas, en español)
├── .gitignore         # node_modules, data, .env
├── GUIA.md            # Este archivo
└── public\
    ├── index.html     # 18 líneas: solo monta <div id="app"> y carga /app.js
    ├── app.js         # Toda la tienda cliente (364 líneas, IIFE "use strict")
    ├── styles.css     # Todo el diseño (205 líneas, CSS denso)
    ├── pcueca-emblema.png   # emblema de marca (única imagen usada en la página)
    └── IMG-20261013-WA*.jpg  # 11 fotos locales (NO se usan; las fotos reales están en MySQL)
```

Nota: esta carpeta **no es un repositorio git**; el dueño sube los cambios a GitHub a mano.

## 3. Variables de entorno

| Variable | Uso |
|---|---|
| `ADMIN_PASSWORD` | Contraseña del panel (obligatoria; sin ella nadie entra) |
| `SESSION_SECRET` | Firma de cookies de sesión (Render la genera con `generateValue: true`) |
| `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME` | Conexión MySQL (o una sola `DATABASE_URL`) |
| `DB_SSL=true` | Si el proveedor exige SSL (`rejectUnauthorized:false`) |
| `PORT` | Lo pone Render (local por defecto 3000) |

Datos actuales en Render: `DB_HOST=dal.gsdb.qorehost.com`, `DB_NAME=s119_Zapatos`.

## 4. Servidor (server.js)

### Arranque
1. `initDb()` crea tablas si no existen y carga el estado en memoria:
   - `tienda_estado(id TINYINT PK=1, datos LONGTEXT)` → JSON completo `{tienda, productos}`.
   - `fotos(nombre VARCHAR(64) PK, tipo, datos LONGBLOB, creada)` → fotos en binario.
2. Si falla la conexión MySQL → `process.exit(1)` (Render mostraría fallo de arranque).

### Estado en memoria
`let state = { tienda: {...}, productos: [...] }`. Toda lectura sale de aquí; toda escritura hace `saveState()` (UPSERT de la fila id=1). Las escrituras se serializan con `exclusive()` (cola de promesas) para evitar carreras.

### Rutas HTTP

| Ruta | Método | Quién | Qué hace |
|---|---|---|---|
| `/healthz` | GET | cualquiera | `ok` (health check de Render) |
| `/api/store` | GET | cualquiera | `publicView()` = tienda + solo productos `visible:true`. Si es admin: estado completo (con ocultos) |
| `/api/me` | GET | cualquiera | `{admin: bool}` |
| `/api/login` | POST | cualquiera | `{password}` → cookie `sid` (7 días). Máx 8 intentos fallidos / 15 min por IP (429) |
| `/api/logout` | POST | cualquiera | Borra la cookie |
| `/api/store` | PUT | solo admin | Guarda **todo** `{tienda, productos}` (máx 300 productos) |
| `/uploads/<nombre>.(jpg/png/webp)` | GET | cualquiera | Sirve la foto desde MySQL con cache 30 días |
| cualquier otro | GET/HEAD | cualquiera | Archivos de `public/` con `no-cache` (protegido contra path traversal) |

- Todo lo que no es `/api/` ni `/healthz` y no es GET/HEAD → 405.
- CSRF: en métodos no-GET valida que `Origin` coincida con `Host` (403 si no).
- Cuerpos: solo `application/json`, máximo **30 MB** (por las fotos en base64).
- Seguridad en todas las respuestas: CSP estricta (`script-src 'self'`; fuentes Google solo style/font), `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy: same-origin`.

### Sesión / autenticación
- Cookie `sid = exp + "." + HMAC-SHA256(exp, SECRET)`; `SECRET` = `SESSION_SECRET` o hash de `ADMIN_PASSWORD`.
- `passOk()` compara SHA-256 con `timingSafeEqual`.
- Cookie `HttpOnly; SameSite=Lax` (+ `Secure` si `x-forwarded-proto: https`).
- `isAdmin(req)` = existe `ADMIN_PASSWORD` y la cookie es válida y no venció.

### Validación (todo se re-valida en el servidor aunque el cliente ya valide)
- `cleanTienda`: nombre hasta 50, ciudad 40, whatsapp solo dígitos (20), dirección/horario 90, bienvenida 200.
- `cleanProduct`: devuelve `null` (respuesta 400) si no hay nombre, precio 0 o ninguna talla.
  - `precioAntes` se anula si es menor o igual al precio. Máx 40 tallas, máx 6 fotos.
  - Fotos válidas solo `/uploads/...` o data URL `image/(jpeg|png|webp)`; **3 MB** máximo (`MAX_PHOTO`) al decodificarse.
  - Categorías fijas: `Tenis, Sandalias, Zapatos, Botas, Infantil, Otros`. "Para": `Mujer, Hombre, Niños, Unisex`.
  - ID válido `[\w-]{1,40}` o se genera; IDs duplicados → 400.
  - Ilustración `ilu` opcional: `{k: sneaker|sandal|loafer, c: #hex, s: #hex}`.

### Fotos (flujo importante)
1. El cliente comprime a JPEG (máx 1000 px, calidad .72) y la envía como **data URL base64** dentro del JSON de `PUT /api/store`.
2. `persistPhotos()` convierte data URLs nuevas en filas de la tabla `fotos` (nombre aleatorio hex) y valida los bytes por magic numbers (JPEG/PNG/WEBP).
3. `cleanupUploads()` **borra de la tabla `fotos` todas las que no estén referenciadas** por algún producto: una foto dejada de usar desaparece para siempre.
4. `/uploads/...` se sirve desde MySQL con `Cache-Control: immutable` (30 días).

## 5. Cliente (public/app.js)

### Arquitectura
- Todo dentro de una IIFE. Estado global: `S` (tienda+productos), `admin`, `preview`, `route`, `cat`, `q`, `ord {z,q}` (talla/cantidad elegidas), `F` (borrador del formulario), `busy`.
- Render reescribiendo `innerHTML` con plantillas de strings + `esc()` (escape HTML). Un solo listener global por evento (`input`, `change`, `submit`, `click`, `keydown`).
- Sin localStorage: el estado viene del servidor; la sesión está en la cookie.

### Navegación (hash routing)
- `#/` → home; `#/p/<id>` → detalle. `hashchange` re-evalúa y hace `render()`.
- `go(id)` cambia el hash, renderiza y hace scroll al top.

### Pantallas
- **Home** (`renderHome`): cabecera sticky (logo/ciudad/botón WhatsApp + buscador) → **catálogo primero** (barra de categorías + grid) → hero (`.hero-banner`, solo `/pcueca-emblema.png`; el banner y el póster se eliminaron) → footer con "Acceso administrador".
- **Detalle** (`renderDetail`): galería con slides + miniaturas, precio con % de descuento, tallas (agotadas deshabilitadas), cantidad, total, botón "Ordenar ahora por WhatsApp"; zoom (lightbox) y swipe.
- **Tarjeta** (`cardHTML`): foto o ilustración SVG de respaldo (`shoe()`: sneaker/sandal/loafer con colores por categoría en `DEF_ILU`), etiquetas: Oculto / Agotado / Pocas unidades (5 o menos) / -%.
- Búsqueda por nombre+marca+categoría+para; filtro por categoría (`renderCats`/`renderGrid`).
- Mejoras estilo adidas: contador de artículos + selector de orden (`#sortsel`, estado `srt`), miga de pan en detalle (`.crumbs` + `data-crumb`), barra de categorías sticky (`.catsbar` con `--hh` medida por `measureHead()`), etiqueta "Nuevo" si `creado` tiene menos de 14 días (campo añadido en `server.js cleanProduct`), 2ª foto al hacer hover en tarjetas (`.pic img.alt`), bloque SEO al final de la home (`.seoblock`) y botón "Volver arriba" (`#totop`).

### Administrador
- Login: footer → "Acceso administrador" → `POST /api/login`. Un 401 en `commit()` cierra la sesión y avisa.
- Barra admin: **+ Nuevo artículo**, **Ajustes**, **Ver como cliente** (`preview`), **Salir**.
- Tarjetas admin: Editar / Ocultar-Publicar / Eliminar (con `askConfirm`).
- Formulario de artículo (modal `openSheet`): nombre, marca, categoría, para, descripción, precio/precio antes, tallas (+ generador de rango "36 a 42, N unidades"), fotos (máx 6, portada = primera, comprimidas en el navegador), checkbox visible.
- **Ajustes**: nombre, ciudad, WhatsApp (indicativo de país, ej. 573001234567), dirección, horario, mensaje de bienvenida.
- Todo se guarda con `commit(next,msg)` → `PUT /api/store` con **el estado completo**; la respuesta reemplaza `S`.

### WhatsApp
- `waLink(p,z,n)` → `https://wa.me/<numero>?text=...`: "Hola, quiero ordenar: Producto (marca) / Talla / Cantidad / Total / link al producto".
- Sin número: toast "Configura tu WhatsApp en Ajustes" (admin) o "La tienda aún no configura su WhatsApp".

## 6. Diseño (public/styles.css)

- Paleta clara: fondo `#eee7d2` (crema), marca `#71352d` (vino), acento `#b43b2e`.
- **Dark mode automático** por `prefers-color-scheme` (fondo `#332522`) y `data-theme="dark"|"light"` en `:root`.
- Estilo neumorphism: `.neu`, `.neu-sm`, `.neu-in` (sombras dobles) + `.glass` (vidrio) + `.press` (pulsar con spring).
- Animaciones: auroras de fondo, brillo del hero, órbita/flotación del zapato, `page-enter`, toasts.
- Tipografía: `Plus Jakarta Sans` (UI), `Playball` (logo), desde Google Fonts (permitidas en la CSP).

## 7. Despliegue en Render

- `render.yaml` (Blueprint): plan **free**, `buildCommand: npm install`, `startCommand: node server.js`, `healthCheckPath: /healthz`.
- Env vars: `DB_*` y `ADMIN_PASSWORD` a mano (`sync: false`), `SESSION_SECRET` se genera sola.
- URL actual: **https://zapatos-8xb2.onrender.com/** (servicio `tienda-zapatos`).
- Git: la carpeta local NO es repo; el dueño sube cambios a GitHub manualmente y Render redespliega.
- Plan gratuito sin disco no importa: todo está en MySQL.

## 8. Ejecutar en local

```powershell
# Requiere Node 18+ y variables DB_* (o DATABASE_URL) apuntando a MySQL
$env:ADMIN_PASSWORD="tu-clave"
$env:DB_HOST="dal.gsdb.qorehost.com"   # y las demás
node server.js                          # http://localhost:3000
```

No hay `npm run dev` ni tests. `node_modules` está gitignored; instalar con `npm install` (solo `mysql2`).

## 9. Cosas a tener en cuenta al hacer cambios

1. **Guardado completo**: `PUT /api/store` reemplaza TODO el estado; un cliente con el JS viejo podría pisar cambios recientes de otro admin.
2. **`cleanupUploads` borra fotos huérfanas** en cada guardado: quitar una referencia la elimina de MySQL para siempre.
3. **Re-valida en `server.js`** (`cleanProduct`/`cleanTienda`): si añades un campo nuevo, valídalo en servidor y cliente.
4. **CSP**: scripts solo de mismo origen; no se puede meter CDNs de JS ni `eval` sin cambiar `headers()`.
5. **Límites**: 3 MB/foto, 6 fotos/producto, 300 productos, 30 MB/cuerpo, 900 caracteres de descripción.
6. **`CATS` y `PARA` están duplicados** en `server.js` y `app.js`: si añades una categoría, cámbiala en los dos archivos.
7. `public/IMG-*.jpg` no se usa desde el código (fotos originales); no borrar sin preguntar.
8. Los cambios de código se ven recién subidos a GitHub (Render redespliega); **los datos NO se pierden** (están en MySQL).
9. El HTML no contiene el texto de la página: todo está en `app.js` dentro de plantillas de strings.

