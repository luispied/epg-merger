# Reglas del proyecto

- **Ayudas al día con cada cambio de interfaz.** Toda la ayuda es una sola página: `worker/web/ui/ayuda.html`, una
  sección por pantalla y modo (`data-pantalla`, `data-modo`), que muestra `worker/web/ui/ayuda.tsx` en Perfil >
  Aplicación y en la Configuración del modo ver. Ninguna pantalla lleva su (?). Todo PR que agrega, cambia o quita algo
  de una pantalla actualiza su sección ahí, o agrega la sección si la pantalla es nueva (`test/ayuda.test.ts` lo exige).
  Una ayuda que describe algo que ya no es así cuenta como un error.
- **Versión y CHANGELOG.** Cada PR que cambia la web sube la versión en `worker/package.json` y agrega su entrada en
  `CHANGELOG.md` (el criterio de mayor, menor y parche está al principio de ese archivo).
- **Merge automático.** Cuando un PR propio tiene el CI en verde, sin conflictos y sin comentarios pendientes, se
  mergea solo (squash), sin preguntar. Si hay PRs apilados, en orden, trayendo `main` a cada uno antes de mergearlo.
- **Design system en toda interfaz y mock.** Todo cambio de interfaz y todo mock usa los tokens de `worker/web/tokens.css` y los componentes y clases que ya existen (`chip-btn`, `segmented`, `ui/kit.tsx`), según `planes/auditoria-diseno.md`. Un solo «elegido» (relleno `--fill`, letra 600); el ámbar es solo para acción y selección, y el verde para lo que está en vivo. Si falta un componente, se agrega a `ui/kit.tsx` en vez de inventar un estilo en la pantalla.
- **Mismos patrones en toda la app.** Lo que se ve al abrir, cargar y fallar es igual en la edición y en el modo ver (y en
  cualquier pantalla nueva): el logo de inicio (`#splash`) se muestra solo al abrir la sesión y se va apenas la pantalla
  dibuja; mientras carga, el esqueleto de `ui/kit.tsx` y nunca un texto «Cargando…»; si no llega, el aviso con «Probar de
  nuevo» y un tiempo máximo para la carga. Antes de hacer un patrón nuevo, buscar si ya existe uno igual en otra pantalla
  y reusarlo. Si un PR cambia uno de estos patrones en una pantalla, cambia también las demás.
