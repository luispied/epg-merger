# Relay: dejar de depender del secret de GitHub

## Por qué
El proveedor bloquea las IPs de Cloudflare. Hoy una corrida de GitHub baja la lista, prueba los canales y lee el
vencimiento con las credenciales del secret `XTREAM_PROFILES`: una cuenta por persona, editada a mano. Para una app
pública no escala (secrets por usuario, topes de minutos de Actions, IPs de GitHub).

## Decisión
Un **relay propio** (`relay/`, Python, contenedor) en un servidor con IP no bloqueada. El Worker descifra las
credenciales del link de cada persona y se las manda por HTTPS con un secret compartido (`RELAY_SECRET`); el relay
las usa y las descarta, no guarda nada ni las escribe en el log, y solo habla con servidores públicos.

## Etapas
1. ✅ Lista: alta de configuración, playlist con lista vieja, cambio de servidores o de datos (esta etapa).
2. ⏳ Prueba de canales caídos y vencimiento de cada cuenta: el cron del Worker llama a `/v1/probe` y `/v1/account`
   (ya existen en el relay) y escribe `health/<cfgId>.json`; «Probar ahora» deja de lanzar `check-streams.yml`.
3. ⏳ Retirar el camino de GitHub para listas y pruebas (`XTREAM_PROFILES`, `known/`, `links/`), dejando en GitHub solo
   lo que no usa credenciales (guía fusionada y guía por configuración).

## Qué hace falta de parte de Luis
- Publicar `relay/` (ver `relay/README.md`) y cargar `RELAY_URL` y `RELAY_SECRET` en el Worker. El secret se genera en
  su computadora y se carga con `wrangler secret put` o el panel; no se pega en ningún chat.
