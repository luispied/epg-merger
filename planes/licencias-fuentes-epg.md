# Licencias de las fuentes de EPG (revisión para la Etapa 1)

Revisado el 29/09/2026 sobre las 56 fuentes activas de `epg_urls.json`, antes de servir la
guía desde Cloudflare para otras personas.

| Proveedor | Fuentes activas | Qué dice |
|---|---|---|
| open-epg.com | 31 | Guías gratis (se banca con donaciones). Sin licencia formal, pero su FAQ fija reglas: ver abajo. |
| epgshare01.online | 19 | "Free EPG for LEGAL use only", no apoya la piratería de ningún tipo y pide no mencionar proveedores de IPTV en el soporte. Arma las guías con WebGrab+Plus (datos tomados de sitios de TV). No habla de redistribución. |
| acidjesuz/EPGTalk (GitHub) | 3 | "Free EPG for LEGAL use only". El repo no tiene archivo de licencia. |
| davidmuma/EPG_dobleM (GitHub) | 1 | Guía gratis para usar en reproductores. El repo no tiene archivo de licencia. |
| epg.programadorx.cl | 1 | Guía gratis ("gratis.xml"). No publica condiciones. |
| iptv-epg.org | 1 | Guías gratis por país. No publica condiciones. |
| iptv-org/database (diccionario de canales, no es guía) | — | Dominio público (CC0). |

## Lo que dicen sus FAQ (29/09/2026)

Luis pasó los links; lo relevante:

- **open-epg** (https://www.open-epg.com/app/faq.php):
  - cada archivo se genera una vez por día y piden bajarlo una sola vez, **después de las
    18:00 CET**;
  - con más de 20 descargas por día y archivo, cortan: devuelven archivos vacíos;
  - sus links personales (Crazy EPG) se pueden compartir **con familia o amigos cercanos**, pero
    si detectan que un link se comparte públicamente ("para todo el mundo en internet"),
    desactivan la cuenta.
- **epgshare01** (https://epgshare01.online):
  - solo para uso legal;
  - no apoya la piratería;
  - pide no mencionar proveedores ni IPTV en el soporte.

Qué implica para Grilla:
1. **Vos y Paola:** está dentro de lo que aceptan. Es uso personal y familiar, y bajamos cada
   archivo una vez por corrida, mucho menos que un reproductor que lo baja solo.
2. **Horario:** la corrida diaria es a las 16:00 UTC, que en invierno europeo (CET) son las
   17:00 CET, antes de que open-epg termine. Conviene pasarla a las 17:30 UTC. Y no lanzar
   corridas a mano de más: hoy hubo 4, lejos del límite de 20, pero suman.
3. **Abrirlo al público:** con varias personas usando la guía, se parece a "compartir
   públicamente" lo de open-epg. Hace falta su permiso antes. Con epgshare01, el producto gira
   alrededor de listas IPTV, que es justo el tema que pide no tocar, así que es probable que no
   lo quiera. Para un servicio público, lo prudente es que las fuentes de epgshare01 las agregue
   cada persona como fuente propia y no vengan en el catálogo del servicio.

## Conclusión

Ninguna fuente de guía da una licencia explícita. Todas se ofrecen gratis para cargarlas en
un reproductor, y dos piden expresamente que sea para uso legal. Los datos de programación
salen, en última instancia, de los canales y de servicios de guías comerciales. Por eso:

1. **La guía no se publica abierta.** El bucket de R2 es privado. El Worker entrega a cada
   configuración solo la guía de sus canales, como hoy el EPG de cada perfil. No hay un link
   público con "toda la guía".
2. **Sin cobro por la guía.** Si algún día se cobra, se cobra por el servicio de organizar la
   lista, nunca por los datos de EPG. Antes de cobrar, hay que pedirles permiso a open-epg y
   epgshare01, que son 50 de las 56 fuentes.
3. **Atribución:** la pantalla "Fuentes de EPG" muestra de dónde sale cada guía, con link al
   proveedor.
4. **Uso legal:** Grilla es "traé tu propia lista". No trae listas ni proveedores, igual que
   piden las fuentes.
5. **Antes de abrirlo a desconocidos** (no para vos ni para Paola): escribirles a open-epg y
   epgshare01 contando el uso (organizador personal, sin cobro, guía acotada a los canales de
   cada persona) y dejar acá la respuesta. Si alguna se opone, se saca del catálogo del
   servicio. Cada persona podría seguir agregándola como fuente propia.
