# Perfiles: varias cuentas y proveedores, con un perfil activo

## Por qué
Luis quiere tener varias cuentas de IPTV (de uno o más proveedores) y cambiar de una a otra en Grilla: la grilla, el
vencimiento, las conexiones y la prueba de canales caídos tienen que ser los de la cuenta activa. Antes no se podía porque
las listas y las pruebas pasaban por el secret de GitHub (una cuenta por persona); con el relay (planes/relay.md) se puede.

## Modelo (decidido 08/10/2026)
- **Proveedor = una configuración** (`cfg/<cfgId>.json`): servidores, lista, guías, nombres, categorías. Cada proveedor
  tiene su propia grilla.
- **Perfil = una cuenta del proveedor** dentro de esa configuración: la principal y las adicionales que ya existen
  (`account` en `short/<código>.json`). Cada perfil tiene su vencimiento, sus conexiones y sus links.
- **Perfil activo**: `activeAccount` en la configuración (vacío = la principal). Lo que corre en segundo plano usa la
  cuenta activa: la prueba de canales caídos (`streamcheck.ts`) y la lista que baja el relay.
- **Hogar**: una clave que junta todas las configuraciones de una persona, para abrir Grilla en otro dispositivo y ver
  todos los proveedores sin importar un respaldo por cada uno. El Worker guarda solo un blob cifrado en el navegador.

## Links: nunca cambian de dirección
La dirección corta (`/l/<código>.m3u8`, `/g/<código>.xml.gz`, `/s/<código>/…`) es la identidad del link. Mover un link
a otro perfil o a otro proveedor cambia a qué configuración y cuenta apunta su registro, nunca el código. El reproductor
no se toca: con la próxima actualización de la lista usa la cuenta nueva. No se borra ni se rota nada (`TOKEN_KEY` igual).

- Mismo proveedor, otro perfil: el registro toma el token de un link de ese perfil.
- Otro proveedor: hace falta la clave de edición de las dos configuraciones (la web las tiene por el hogar). El token
  está atado a su configuración (cfgId como dato asociado), así que se usa el de un link del perfil de destino o, si
  ese perfil no tiene links, las credenciales que manda la web, cifradas para el destino.

## Interfaz (opción E, elegida por Luis)
Maqueta: https://claude.ai/artifact/SyGGdMx6tLMAWb7nVNZwtN
- La pestaña de abajo «Links» pasa a **«Perfil»**, con un avatar con la inicial del perfil activo (el texto siempre
  dice «Perfil», no el nombre).
- Tocarla abre Perfiles: una tarjeta por perfil, agrupadas por proveedor, con suscripción, conexiones, caídos y sus
  links; «Usar» lo vuelve el activo. Mantenerla apretada cambia de perfil directo.
- En Canales aparece un aviso solo cuando hay algo que mirar (vence pronto, conexiones llenas, caídos).
- Ayuda y Configuración quedan arriba a la derecha. Configuración es la del proveedor del perfil activo.
- Desde un link: «Mover a otro perfil», con la dirección a la vista para dejar claro que no cambia.

## Etapas
1. ✅ Worker: `activeAccount`, prueba y lista con la cuenta activa, mover links entre perfiles y proveedores, hogar (1.20.0).
2. ✅ Web, un proveedor: pestaña Perfil, tarjetas por perfil con suscripción, conexiones en uso y caídos, perfil activo,
   cambio rápido, mover link a otro perfil, aviso en Canales (1.21.0). Conexiones en uso: `activeConnections` del relay
   (hay que volver a publicar `relay/`).
3. ✅ Web, varios proveedores: la web guarda varias configuraciones (una por proveedor) en el hogar, Perfiles las agrupa por
   proveedor, cambiar a un perfil de otro proveedor cambia la grilla, mover un link entre proveedores y código de hogar
   para abrir todo en otro dispositivo (1.22.0).
4. ✅ Pantalla Perfiles rediseñada (opción H de la maqueta, 1.23.0): lista por proveedor, página por perfil, por proveedor y
   del hogar; renombrar perfiles (`PUT /api/cfg/<id>/profiles`, `mainName` para la principal) y borrarlos moviendo sus
   links a otro perfil (nunca se borra un link). Lo de cada cuenta y proveedor salió de Configuración.
