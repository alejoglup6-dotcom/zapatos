# Tienda de zapatos

Tienda sencilla: catálogo, página de detalle por artículo, panel de administrador
(crear/editar/ocultar/eliminar artículos con fotos, tallas y unidades) y botón
"Ordenar ahora" que abre WhatsApp con el pedido escrito.

No tiene dependencias: solo necesita Node 18 o superior.

## Probar en tu computador
    ADMIN_PASSWORD=tu-clave node server.js
    # abre http://localhost:3000  (los datos quedan en ./data)

## Subir a Render
1. Sube esta carpeta a un repositorio de GitHub.
2. En Render: New + > Blueprint, elige el repositorio (usa render.yaml).
   - Plan de pago (Starter) porque necesita un disco para no perder los datos.
3. Cuando Render lo pida, escribe ADMIN_PASSWORD (una clave larga).
4. Abre la URL, pulsa "Acceso administrador" al final de la página, entra y ve a
   Ajustes para poner nombre, ciudad y tu WhatsApp con indicativo (ej. 573001234567).

Sin disco (plan gratuito) los artículos y fotos se borran en cada reinicio o despliegue.

## Respaldo
Todo está en la carpeta DATA_DIR: tienda.json y uploads/. Copiarla es el respaldo.
