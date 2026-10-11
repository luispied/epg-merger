# Auditoría de diseño (octubre 2026)

## Por qué
Revisión del estilo de Grilla web sobre la 1.36.2 (los dos CSS, los componentes Preact, las animaciones y 44 capturas
en iPhone y escritorio, claro y oscuro). Informe completo: el artifact «Auditoría visual de Grilla»; las capturas
originales, en `auditorias/diseno-2026-10/capturas/` de los archivos del proyecto.

La base es buena (colores por rol, áreas táctiles de 44 px, un ámbar por pantalla en Canales, cifras tabulares, entradas
cortas), pero cada etapa sumó su capa: `--accent` definido en 5 lugares, 21 bloques `:root`, 22 tamaños de letra,
25 radios, 15 z-index, 153 selectores repetidos y cinco formas de mostrar «elegido».

## Plan (cuatro PRs, de menos a más riesgo)
1. **Errores visibles** (parche): búsqueda debajo del panel en escritorio, cápsula de abajo más opaca, hora que tapa la
   marca de la Guía, programas cortos sin texto, «quedan 42 min» entero en el modo ver, hover solo con mouse, avisos
   de las hojas con `aria-live`, spinner con «reducir movimiento», un solo monograma.
2. **Tokens y una sola paleta** (menor): primero la prueba de capturas en el CI; después `tokens.css` con
   `light-dark()`, escalas cerradas (letra, espacio, radio, z-index, tiempos) y `--live`; borrar lo pisado de `base.css`.
3. **Componentes y regla del ámbar en toda la app** (menor): `ui/kit.tsx` (`<Sheet>`, `<ListGroup>`/`<Row>`, `<Chip>`,
   `<Segmented>`, `<Kicker>`, `<Progress>`, `<Mono>`); verde para «en vivo», ámbar solo para acción o selección; un solo
   «elegido»; hojas con salida animada y manija que se arrastra.
4. **Escritorio y extras** (menor): barra lateral en escritorio, View Transitions entre pestañas, esqueleto de la Guía,
   «letra grande», Stylelint en el CI.

## Prueba de capturas
`worker/e2e/visual.spec.ts`: 12 pantallas (bienvenida, Canales, hoja del canal, Configuración, Categorías, Perfil, la
Guía en sus tres modos, la hoja del programa y el modo ver) en iPhone y escritorio, claro y oscuro, con la hora
congelada y datos fijos. No guarda capturas en el repo: el trabajo «visual» de `check-worker.yml` saca las de main y las
del PR en la misma máquina, con la misma prueba, y las compara sin tolerancia. Es informativo: el resumen de la corrida
dice qué pantallas cambiaron y las diferencias quedan en el artifact «capturas». Para un PR que no debería cambiar nada
a la vista (como el de tokens), tiene que decir «Ninguna pantalla cambió».

## Estado
- ✅ 1.36.4: paso 1 (#281).
- ✅ Paso 2a: prueba de capturas en el CI (#282).
- ✅ 1.36.5: paso 2b. `worker/web/tokens.css` es el único lugar que define los tokens: cada uno con su claro y su
  oscuro en `light-dark(claro, oscuro)`, que `worker/tokens.mjs` expande al armar `app.css` en los bloques de siempre
  (así anda en iPhones viejos y sirve para sombras). Escalas definidas (`--fs-*`, `--sp-*`, `--z-*`, `--dur-*`,
  `--ease-*`, `--radius-full`) y `--live`; las pantallas las adoptan en el paso 3, que es el que cambia lo que se ve.
  De `base.css` se borraron 171 declaraciones que `web.css` pisaba enteras. Sin cambios a la vista (0 diferencias).
- Pendiente: pasos 3 y 4.
