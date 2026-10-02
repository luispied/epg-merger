# Etapa 0.5: que otra persona pueda usar Grilla sin tocar código

> **Cerrada (02/10/2026): no se hace.** La reemplazó la Etapa 1 (Grilla web sin GitHub), que ya
> está en producción y resuelve lo mismo sin forks ni tokens por persona.

> **Opcional (28/09/2026).** El camino principal pasó a ser `planes/etapa-1-web-sin-github.md`
> (Grilla web sin GitHub, sin repo, gist ni token por persona). Esta etapa solo tiene sentido
> si antes de eso se quiere que alguien use su propio fork. Puntos que conviene hacer igual,
> porque también sirven para vos hoy: **"Tus links"** (punto 2) y el **repo detectado solo**
> (punto 1).

Prerrequisito: `planes/etapa-0-generico.md` (✅). Va antes de la app pública (`planes/app-publica.md`)
y no la reemplaza: sigue siendo "cada persona con su copia en GitHub", pero sin editar archivos
ni secrets a mano.

## Contexto
Hoy Grilla sirve para **corregir** la playlist, pero no para **armarla**:

- **Credenciales:** se cargan a mano en el secret `XTREAM_PROFILES` (repo → Settings → Secrets
  and variables → Actions), un JSON con todos los perfiles. Grilla no lo ve ni lo puede editar.
- **Resultado:** la playlist va a un gist secreto (requiere crear el gist, copiar su id al
  secret y un segundo token `GIST_TOKEN`) y el EPG al release `latest`
  (`…/releases/download/latest/epg-<perfil>.xml.gz`). Grilla no muestra ninguna de las dos URLs.
- **Otra persona** tendría que hacer un fork, crear gist y tokens, cargar secrets, activar
  Actions y Pages y cambiar `REPO = 'luispied/epg-merger'` en `docs/app.js`. Además heredaría
  tu configuración: tus overrides, categorías ocultas, reglas de tu proveedor y fuentes.

Resultado buscado: **fork + un token → asistente en Grilla → links para pegar en el
reproductor**, sin editar nada a mano.

## Trabajo, en PRs separados (se mergean al estar en verde)

### 1. Repo detectado solo
- `docs/app.js`: `REPO` sale de la dirección de la página (`<usuario>.github.io/<repo>/` →
  `<usuario>/<repo>`). Con dominio propio o abriéndolo local, se usa un override guardado en
  Configuración (localStorage) y, como último recurso, `luispied/epg-merger`.
- Todo lo que hoy arma URLs con `REPO` (API, raw de `main` y de `data`, workflow) pasa a usar
  el valor detectado. En Configuración → Acerca de se muestra de qué repo lee.

### 2. "Tus links" (Configuración)
- Por cada perfil: **URL de la playlist** (gist) y **URL del EPG** (release), con botón
  Copiar y un QR para cargarlas en la tele sin tipear.
- **Qué perfiles hay:** nuevo `profiles.json` en el repo, **sin credenciales**: solo
  `name`, `type` (xtream | m3u) y cuándo se actualizó. Lo escribe Grilla (punto 3); el
  workflow lo usa para saber qué secrets leer.
- **Dónde está el gist:** `publish_playlists.py` deja de necesitar `gist_id`. Busca entre
  los gists del token uno con descripción `Grilla · playlist <perfil> · <repo>` y, si no
  existe, lo **crea** (secreto). Grilla lo encuentra igual, por descripción, con el token de
  la persona (`GET /gists`). El id del gist nunca se escribe en el repo: su URL da acceso a
  la playlist, que lleva las credenciales.
- El `gist_id` explícito en el perfil sigue funcionando (tu configuración actual no cambia).

### 3. "Proveedor" (Configuración): cargar Xtream o M3U desde Grilla
- Formulario por perfil:
  - **Xtream:** servidor(es), usuario y contraseña;
  - **M3U:** URL de la lista.
  - Botón "Probar": el navegador no puede llamar al proveedor (CORS / http), así que la
    prueba se hace lanzando el workflow en un modo "solo validar" (`workflow_dispatch` con
    input `validate_profile`), que responde en el log "N canales, M categorías" sin publicar
    nada.
- **Guardado como secret, cifrado en el navegador:** un secret por perfil,
  `GRILLA_PROFILE_<NOMBRE>`, vía `PUT /repos/{repo}/actions/secrets/{name}`. El valor se
  cifra con la clave pública del repo (sealed box de libsodium) antes de salir del
  navegador; GitHub no deja leerlo después, ni a Grilla ni a nadie. Un secret por perfil
  permite editar uno sin volver a tipear los demás (con un único JSON habría que reescribirlo
  entero).
  - libsodium se carga solo al guardar, desde jsDelivr con hash SRI fijo, para no sumar peso
    a la carga normal.
- `profiles.py`: además de `XTREAM_PROFILES` (lo de hoy, sigue funcionando), lee los
  `GRILLA_PROFILE_*`. El workflow los recibe con `${{ toJSON(secrets) }}` en una variable
  que solo lee Python (nunca se expande en el shell) y GitHub los enmascara en el log.
- Borrar un perfil: borra su secret y su entrada en `profiles.json`.
- **Token:** el mismo PAT que ya usa Grilla, con permisos documentados. Fine-grained: sobre
  el repo **Contents**, **Actions** y **Secrets** en escritura, y en la cuenta **Gists** en
  escritura. Grilla verifica los permisos al pegarlo y dice cuál falta.
- `GIST_TOKEN` deja de ser un secret aparte: el asistente guarda el mismo token como secret
  `GIST_TOKEN` (cifrado igual), si la persona acepta.

### 4. Asistente de primer uso
Al abrir Grilla en un repo sin `profiles.json` (un fork recién hecho):
1. **Token:** pegar el token, con link a crearlo con los permisos ya marcados.
2. **Proveedor:** el formulario del punto 3.
3. **Empezar de cero:** ofrece vaciar lo heredado del repo original:
   - `xtream_channel_map.json` → vacío;
   - `provider_rules.json` → genérico (sin separadores ni reglas de otro proveedor);
   - `epg_urls.json` → un punto de partida chico según el país que elija (las fuentes
     `fresh` de ese país del catálogo); después las **sugeridas** de Fuentes de EPG hacen
     el resto.
4. **Primera corrida:** lanza el workflow y muestra el avance (ya existe).
5. **Tus links:** al terminar, lleva a la pantalla del punto 2.

### 5. Guía para hacer el fork
- README: sección "Usar Grilla con tu proveedor" en 3 pasos: fork (o "Use this template"),
  activar Actions y Pages (con capturas), abrir `https://<usuario>.github.io/<repo>/`.
- El workflow diario ya corre solo en el fork; el semanal de fuentes también.

## Seguridad (se mantiene lo de siempre)
- Las credenciales nunca se commitean ni se muestran: van cifradas directo del navegador a
  los secrets de GitHub, y en el workflow solo las lee Python.
- El token sigue guardado solo en ese navegador y solo se manda a `api.github.com`.
- `profiles.json`, `match_report` y la branch `data` siguen sin credenciales.
- Las URLs de gist son "inadivinables", no privadas (como hoy): Grilla lo explica al lado
  del botón Copiar.

## Archivos clave
- **Nuevos:** `profiles.json`, `planes/etapa-0-5-autoservicio.md`.
- **A modificar:** `docs/app.js`, `docs/index.html`, `docs/types.d.ts` (repo detectado, Tus
  links, Proveedor, asistente); `profiles.py` (`GRILLA_PROFILE_*`); `publish_playlists.py`
  (buscar/crear gist); `.github/workflows/merge-epgs.yml` (secrets por perfil, modo
  validar); `README.md`.
- **A reutilizar:** `withRepoJson` y `changeSources` (escritura con Deshacer), el
  seguimiento del workflow de la interfaz, `providers.py` (validación), `source_coverage.py`
  (fuentes iniciales por país).

## Verificación
- **Sin regresión para vos:** con `XTREAM_PROFILES` y los `gist_id` actuales, la corrida
  publica en los mismos gists y el `match_report` no cambia.
- **Fork de prueba** (otra cuenta o un repo nuevo): siguiendo solo la guía y el asistente, se
  llega a los links de playlist y EPG, y esos links cargan en un reproductor.
- **Secrets:** tests de `profiles.py` con `GRILLA_PROFILE_*` y con el formato viejo; Playwright
  del formulario con la API de GitHub simulada, verificando que el `PUT` del secret lleva
  el valor cifrado (nunca el texto plano).
- **Gists:** tests de `publish_playlists.py` con API simulada: encuentra por descripción, crea
  si no existe y sigue usando `gist_id` si está.
- Siempre: tests, `tsc -p docs`, chequeo de versiones de assets.
