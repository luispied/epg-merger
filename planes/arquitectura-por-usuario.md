# Arquitectura por usuario: qué depende todavía de la cuenta de Luis

Análisis del 12/10/2026 a partir del código de `main`, para abrir Nowline a más usuarios. Pregunta de Luis: si cada
persona tiene su propia configuración, ¿por qué la corrida diaria todavía usa los secretos `XTREAM_*`?

## Respuesta corta
La arquitectura está bien pensada y casi toda ya es por usuario. Queda **un resto del tiempo en que Luis era el único
usuario**: la corrida diaria arma lo compartido de toda la guía (programación, catálogo) *dentro* del paso que cruza la
lista de Luis, y ese paso se corta si no hay perfiles. No hace falta una corrida por usuario: hace falta sacar a Luis
del camino de lo compartido.

## Qué ya es por usuario
- **Configuración anónima** (`cfg/<cfgId>.json`) con clave de edición; las credenciales viajan cifradas dentro del link
  (`planes/etapa-1-web-sin-github.md`) y el Worker no las guarda.
- **Lista, canales caídos y vencimiento** por usuario, vía relay (`planes/relay.md`, etapas 1 a 3 hechas).
- **Guía propia** `epg/<cfgId>.xml.gz` e **índice por hora propio** `ui/schedule/cfg/<cfgId>`: la corrida los arma todos en
  una pasada (`tools/r2_upload.sh:65`) y `refresh-lists.yml` arma las nuevas o editadas cada 3 horas.
- **Hábitos, avisos, perfiles y links** por configuración, todo en el Worker y R2.
- **Fuentes automáticas**: la demanda ya incluye las configuraciones de la web (`tools/auto_sources.py`, `load_web`).

## Por qué la corrida diaria NO debe ser por usuario
Lo caro (bajar y fusionar las fuentes, indexar, programación de ~17.500 canales) es idéntico para todos. Una corrida por
usuario multiplicaría los minutos de Actions por la cantidad de usuarios sin cambiar el resultado. Lo que sí es por
usuario (su guía y su índice) ya se deriva de lo compartido en una sola pasada. Eso es lo que decidió la Etapa 1.

## Qué todavía depende de Luis
1. **`generate_playlist.generate()` se corta sin perfiles** (`generate_playlist.py:1001`). Pero la programación
   (`ScheduleCollector`), el catálogo y los íconos salen solo de la guía fusionada, no de ningún perfil. Sin los
   `XTREAM_*`, no se escribe `out/schedule/`, y de ahí cuelgan las tandas `ui/schedule/s`, el índice por hora (de todos y
   de cada configuración), la medición y la clasificación con IA. **La Guía y Tu plan de todos los usuarios dependen de
   que el secreto de Luis exista.**
2. **El reporte de cruce por perfil** (`out/<perfil>/match_report.json`) alimenta `source_coverage.py` y, junto con las
   configuraciones web, la demanda de `auto_sources.py`. Para un usuario de la web esa demanda ya sale de su
   configuración; el perfil de Luis es redundante (Luis también tiene configuración).
3. **Pruebas con la lista de Luis**: `match_benchmark.py --errors 3` y `core_parity.py --luis` usan su reporte como
   referencia. Es un banco de pruebas, no producción, pero hoy comparte el mismo secreto.
4. **`GIST_TOKEN` y `XTREAM_GIST_ID`**: nada los usa; sobras de cuando las playlists iban por gists.

Un secreto con credenciales de una persona en un repo que sirve a otras es además un riesgo en sí: la meta es **cero
credenciales de usuarios en GitHub**.

## Límites de escala a medir (no medidos todavía)
- La pasada de `tools/config_epgs.py` abre **un gzip por configuración a la vez** y prueba cada programa contra el
  conjunto de cada una: el costo crece con programas × configuraciones. Con unas pocas docenas es chico; con cientos o
  miles puede acercarse al tope de 60 minutos del trabajo o al límite de archivos abiertos.
- **Tamaño en R2**: una guía por configuración cada día (almacenamiento y escrituras ~1 por configuración por día, y
  otro tanto para el índice por hora). Hay que medir el tamaño real de una guía típica para proyectar los 10 GB gratis.
- **Configuraciones abandonadas**: resuelto: las que no se editan ni usan un link en 30 días dejan de recibir guía
  nueva (`tools/config_activity.py`, ver `docs/pipeline-epg.md`). Sus links y su guía existente no se tocan.
- **Minutos de Actions**: depende de si el repo es público (gratis) o privado (tope mensual).

## Plan propuesto
1. **Separar `generate()`** en una etapa compartida (programación, catálogo, íconos; siempre) y una etapa por perfil
   (cruce y reporte; opcional, solo si hay perfiles). Prueba: la corrida completa sin ningún `XTREAM_*`.
2. **Sacar a Luis de la demanda de fuentes automáticas**: queda solo la de las configuraciones web (el perfil sigue
   sumando si existe, sin ser necesario).
3. **Luis borra** `XTREAM_PROFILES`, `XTREAM_USERNAME`, `XTREAM_PASSWORD`, `XTREAM_SERVERS`, `GIST_TOKEN` y
   `XTREAM_GIST_ID`. El smoke test y los bancos con su lista pasan a usar un secreto aparte, marcado como de pruebas
   (o se pasan a mano al lanzarlos).
4. **Escala**: medir el tiempo y el tamaño de la pasada por configuración con configuraciones sintéticas (50, 500,
   2.000); apagar la guía de las configuraciones sin uso en N días; decidir el tope de usuarios para el plan gratis.

Los pasos 1 a 3 son chicos y no cambian la interfaz. El 4 define cuántos usuarios entran antes de pagar algo.
