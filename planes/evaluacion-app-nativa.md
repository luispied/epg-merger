# Evaluación: PWA vs. app nativa para Grilla

Estado: Grilla web ya es una PWA (instalable, service worker, funciona sin conexión con los cambios guardados en el dispositivo). La pregunta es si hace falta una app nativa.

## Lo que la PWA ya cubre
- Instalación en la pantalla de inicio (Android e iOS), pantalla completa y sin barra del navegador.
- Edición sin conexión y sincronización al volver la red (píldora de estado arriba).
- Un solo código para celular y escritorio (panel fijo a la derecha desde 1100 px).
- Sin tiendas, sin revisión, sin comisiones; las actualizaciones llegan al instante.
- Las credenciales no se guardan en texto plano: solo van cifradas dentro de los links.

## Lo que la PWA no resuelve
| Tema | PWA | Nativa |
|---|---|---|
| Aparecer en App Store / Play | No | Sí (pero ver riesgo de rechazo por IPTV) |
| Llavero del sistema (iOS) / Keystore | No (solo sessionStorage por pestaña) | Sí |
| Refresco en segundo plano programado | Limitado (iOS casi nulo) | Sí |
| Apple TV / Android TV | No | Sí, con trabajo extra (tvOS) |
| Compartir "hacia" la app desde otra | Parcial (Web Share Target solo Android) | Sí |
| Notificaciones push | iOS 16.4+ solo si está instalada | Sí |

## Riesgos de ir nativo
- Apple suele rechazar o escrutar apps de IPTV (guías 5.2.2 y 5.2.3): hay que presentar la app como "traé tu propia lista", sin contenido ni proveedores, y dar una lista de demo legal al revisor.
- Costo de mantener dos clientes (web + app) y portar el matcher a TypeScript compartido con test de paridad.
- Licencias de las fuentes de EPG (ver `licencias-fuentes-epg.md`).

## Recomendación
1. **Ahora:** quedarse en PWA. Cubre el caso real (editar la lista desde el celular y copiar los links al reproductor).
2. **Disparadores para pasar a nativa** (cualquiera alcanza):
   - muchos usuarios piden guardar credenciales de forma segura entre sesiones;
   - se necesita refresco en segundo plano en iOS;
   - hay demanda concreta de Apple TV;
   - se quiere presencia en tiendas.
3. **Si se decide:** React Native / Expo (iOS, iPadOS, Android), reutilizando `@grilla/core` y el Worker de entrega, tal como en `app-publica.md`.
