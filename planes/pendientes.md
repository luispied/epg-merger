# Pendientes de Grilla (relay, escala y mejoras)

Archivo para retomar el trabajo en otra sesión. Actualizado el 07/10/2026. Contexto técnico del relay: `planes/relay.md`.

## Estado actual
- Worker 1.18.0 en `grilla.grilla.workers.dev`. Relay en Fly (`epg-merger`, `https://epg-merger.fly.dev`, región gru, una máquina con auto-stop, IPv4 compartida, tarjeta agregada).
- Etapas 1 y 2 del relay hechas: listas, prueba de canales caídos y vencimiento por cuenta, todo desde el Worker. El PR #219 hace que el relay no loguee datos de cuenta.
- El camino viejo de GitHub (`refresh-lists.yml`, `check-streams.yml`, secret `XTREAM_PROFILES`) sigue como respaldo.

## A. Pendientes de Luis
1. `git pull` y `fly deploy` desde la raíz del repo, para aplicar #219 (sin confirmar).
2. Rotar `RELAY_SECRET` (el anterior se pegó en un chat). Generarlo con `openssl rand -base64 48` y cargarlo con `fly secrets set` y `wrangler secret put RELAY_SECRET`. Borrar los secrets mal nombrados con `wrangler secret delete`.
3. En 1–2 días, mirar `fly logs -a epg-merger`: tienen que aparecer `POST /v1/probe 200` y `POST /v1/account 200`. En Configuración tienen que verse «Canales caídos» y «Tu suscripción».
4. Revisar el panel de Billing de Fly. La IPv6 «dedicated» debería ser gratis; confirmarlo. Opcional: `fly scale memory 256 -a epg-merger`.
5. Opcional: segundo perfil en `XTREAM_PROFILES` para el vencimiento de la cuenta familiar (solo mientras exista el camino de GitHub).

## B. Esperan un «sí» de Luis
1. **Mejorar ahora:**
   - chequeo de `/health` en `fly.toml` y una sola máquina;
   - indicador en Configuración con la última vez que el relay bajó listas y probó canales;
   - tope diario de uso del relay;
   - aviso si el relay falla.
2. Subir `BATCH` de la prueba de canales de 200 a ~500 y revisar el presupuesto de tiempo (hoy se prueban 200 de 1363 por corrida).
3. Zona horaria de México: agregar la opción «UTC-5 (fijo)» y/o cambiar el valor por defecto (hoy `America/Mexico_City`, UTC-6).

## C. Etapa 3: retirar el camino de GitHub
Solo después de 1–2 días estables y con confirmación de Luis.
- Antes, revisar qué más usa `XTREAM_PROFILES`.
- Quitar `refresh-lists.yml`, `check-streams.yml`, `tools/push_lists.py`, `tools/check_streams.py`, la lógica de `known/` y `links/` (`linkWithGithub`, `knownToGithub`, `linkConfig`, `isLinked`), `refreshOnDemand`, los dispatch de listas y salud, y el secret.
- Los links de los dispositivos no cambian.

## D. Escala (más adelante)
- Cola o cursor en el cron de `*/30`.
- Guía por configuración generada fuera de Actions.
- Rotación de `RELAY_SECRET` con dos secrets vigentes a la vez.
- IP de salida estática, opcional.

## E. Reglas que no se rompen
- Nunca desactivar la verificación TLS.
- Nunca pedir ni pegar secrets o tokens en el chat: se generan en local y se cargan con `fly secrets set` / `wrangler secret put`.
- Credenciales solo dentro de tokens cifrados; el relay no guarda ni loguea nada de cuentas.
- El token de GitHub solo se usa contra `api.github.com`.
- Sin identificadores de modelo en commits, PRs, comentarios ni archivos del repo.
- La visibilidad del repo la cambia Luis.

## F. Cómo retomar
- Leer este archivo y `planes/relay.md`.
- Tests: `node --test` en `worker/` (51), `pytest` (189) y los e2e con Playwright.
- Rama de trabajo: `claude/epg-merger-docs-access-60boeo`. Si su PR ya se mergeó, reiniciarla desde `origin/main` antes de seguir.
