# Que se note que ×, ‹ y › de las hojas son botones

## Por qué
Luis (10/10/2026): en las hojas, los botones de cerrar (×), atrás o anterior (‹) y siguiente (›) casi no se notan.
La causa: `.icon-btn` (`worker/web/web.css`) no tiene fondo, el ícono va en `--muted` y el fondo solo aparece con
`:hover`, que en el celular no existe. Quedan como íconos sueltos al lado del título.

## Qué se cambia
Solo los botones del encabezado de las hojas (`dialog .title-row .icon-btn`): cerrar, volver, anterior y siguiente,
y la ayuda de Perfil. Pasa en todas: canal, categoría, Perfil, ayuda, Configuración, programa de la Guía, «La guía no
coincide», «Tu código», «Categorías» de la Guía y la hoja del canal del modo ver. No se tocan los botones de la barra
de arriba de la app ni los de las filas («…», plegar).

- Un círculo de fondo siempre visible (`--fill`) y el ícono en el color del texto.
- Al pasar el mouse, un poco más oscuro. Al apretar, más oscuro y apenas más chico, para que se sienta el toque.
- Anterior y siguiente sin a dónde ir (el primero o el último): sin fondo, con un borde fino y el ícono apagado. Así
  se ve que existe, pero que ahora no hace nada.
- Sin cambios de comportamiento ni de textos, así que la ayuda no cambia.

## Estado
- ✅ 1.33.1: el CSS, con capturas de antes y después en claro y oscuro (canal, categoría y ayuda) y la suite e2e entera.
- 1.34.0: las páginas (Perfil, Categorías) usan el mismo estilo y su encabezado fijo ya no deja ver lo que se desplaza.
