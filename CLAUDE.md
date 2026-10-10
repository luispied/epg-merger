# Reglas del proyecto

- **Ayudas al día con cada cambio de interfaz.** Todo PR que agrega, cambia o quita algo de la interfaz (una pantalla,
  un botón, un texto, un gesto) actualiza la ayuda donde corresponde, o agrega una nueva si no hay: los temas de
  `worker/web/index.html` (`.help-topic`: main, settings, categories, links), los textos `<Help>` de las pantallas en
  `worker/web/ui/*.tsx` y los textos de ayuda del modo ver (`worker/web/ver.tsx`). Una ayuda que describe algo que ya
  no es así cuenta como un error.
- **Versión y CHANGELOG.** Cada PR que cambia la web sube la versión en `worker/package.json` y agrega su entrada en
  `CHANGELOG.md` (el criterio de mayor, menor y parche está al principio de ese archivo).
