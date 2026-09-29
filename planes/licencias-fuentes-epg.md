# Licencias de las fuentes de EPG (revisión para la Etapa 1)

Revisado el 29/09/2026 sobre las 56 fuentes activas de `epg_urls.json`, antes de servir la
guía desde Cloudflare para otras personas.

| Proveedor | Fuentes activas | Qué dice |
|---|---|---|
| open-epg.com | 31 | Guías gratis. No publica una licencia ni condiciones de uso. |
| epgshare01.online | 19 | "Free EPG for LEGAL use only". No habla de redistribución. |
| acidjesuz/EPGTalk (GitHub) | 3 | "Free EPG for LEGAL use only". El repo no tiene archivo de licencia. |
| davidmuma/EPG_dobleM (GitHub) | 1 | Guía gratis para usar en reproductores. El repo no tiene archivo de licencia. |
| epg.programadorx.cl | 1 | Guía gratis ("gratis.xml"). No publica condiciones. |
| iptv-epg.org | 1 | Guías gratis por país. No publica condiciones. |
| iptv-org/database (diccionario de canales, no es guía) | — | Dominio público (CC0). |

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
