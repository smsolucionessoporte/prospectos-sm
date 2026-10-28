# SM Comercial — reemplazo evolutivo de SM Prospectos

## Decisión de producto

**SM Comercial reemplaza a SM Prospectos**. No es una segunda aplicación ni crea otra base. Se conserva el despliegue actual en Railway, las credenciales, las entidades de prospectos, las estadísticas históricas, las rutas internas, integraciones y conversaciones de Chatwoot. El menú y el inicio de sesión conducen a `/crm`; `/panel` se conserva como Oportunidades y `/control` como Resultados.

La aplicación móvil es una **PWA instalable** desde navegador en Android/iPhone. Requiere HTTPS, compatible con Railway. Es el mismo código y la misma información; las páginas con información privada **no se cachean** en el dispositivo.

## Entrega 1 — Operación básica (archivos incluidos)

- Nueva marca: SM Comercial.
- Inicio en Mi agenda, para vendedor y supervisión.
- Cola de casos derivados sin primera atención registrada.
- Agenda de tareas con responsable, tipo, prioridad, vencimiento, creación y acción de completar.
- Demos coordinadas y oportunidades con demo realizada pendientes de cierre.
- Accesos a fichas, Chatwoot y estadísticas existentes.
- Interfaz adaptada a teléfonos, manifest PWA, iconos y caché **solo** de recursos estáticos.
- Resumen de agenda por WhatsApp, a las 09:00 para vendedores y a las 16:30 para supervisor, con registro de idempotencia. Por seguridad los envíos se activan solo al configurar la variable `CRM_ALERTAS_WHATSAPP=true` y validar destinatarios.

### Variables

- `CRM_ALERTAS_WHATSAPP=true`: habilita recordatorios privados y resumen de supervisión.
- `CRM_SUPERVISOR_USUARIO_ID=6`: ejemplo de usuario que recibirá el resumen; revisar quién será el supervisor antes de habilitar.
- Se reutilizan `APP_URL`, `CHATWOOT_URL`, `CHATWOOT_ACCOUNT_ID`, `CHATWOOT_API_TOKEN` y `BOT_INBOX_ID`.
- Los teléfonos del equipo están actualmente en `src/zoomAgentes.js`; **verificar y completar el de Santiago** antes de habilitar los avisos. La agenda funciona aunque no estén habilitados los mensajes.

## Entrega 2 — Sincronización automática bidireccional (pendiente)

- Detectar toda última respuesta entrante y última respuesta humana, incluidas conversaciones ya atendidas, **sin confundir estados Pendiente/Abierto de Chatwoot**.
- Generar/actualizar compromisos automáticamente por cambio de estado, demo, reclasificación y reasignación. Asociar varias conversaciones a un mismo prospecto.
- Bandeja de notificaciones dentro de la PWA con contador y avisos de tareas vencidas; push móvil solo con consentimiento y VAPID.
- Historial de acciones y auditoría de cambios que distinga acción humana de integración y token técnico.

## Entrega 3 — Supervisión y escalamiento (pendiente)

- Filtros por vendedor, prioridades, SLA y tareas sin próximo paso.
- Escalamiento progresivo por incumplimientos y resumen de gestión, manteniendo las reglas de primera atención 1 h / 2 h / reasignación 3 h dentro de 9–17.
- Embudo comercial por origen, demos y confirmados; métricas de cumplimiento, tiempos hasta cierre, razones de pérdida.

## Criterios de aceptación

1. El vendedor inicia sesión en la misma URL de Railway y aterriza en Mi agenda; ve solo sus registros y tareas.
2. El administrador ve todas las tareas y puede asignarlas a un vendedor.
3. Al crear y completar una tarea, el cambio persiste en Postgres.
4. Se conservan accesibles `/panel`, `/control`, fichas, relevamientos, demos y campañas existentes.
5. La PWA se instala desde HTTPS. No se guarda HTML autenticado en caché.
6. Un recordatorio de un día para un vendedor se envía como máximo una vez, y solo con el canal expresamente habilitado.

## Riesgos y despliegue

1. Respaldar PostgreSQL y confirmar que Railway ejecuta el artefacto actualizado.
2. Reemplazar solamente los archivos adjuntos, ejecutar `git add`, `git commit`, `git push`.
3. Verificar el despliegue, iniciar sesión y crear una tarea de prueba.
4. Probar la instalación móvil. Antes de habilitar recordatorios externos, verificar los números de WhatsApp de cada vendedor y la identidad de la cuenta técnica que envía mensajes.

**Importante:** esta es una primera versión real de SM Comercial, no la totalidad del CRM. Los envíos de notificaciones no se activan hasta configurar la variable indicada; el monitoreo de mensajes posteriores a la primera atención también forma parte de la entrega 2.

## Entrega 2A — Priorización de conversaciones y tareas automáticas (28/10/2026)

Esta entrega modifica **la misma aplicación SM Comercial**; no es otra plataforma.

- `src/crm/sync.js` consulta en ciclos la API de Chatwoot (máximo 40 conversaciones por ronda,
  cuatro solicitudes concurrentes) y guarda un resumen de la última entrada, última salida de asesor,
  responsable, nombre real y estado. Se verifican oportunidades derivadas de hasta **45 días**.
- El panel solo muestra como urgentes mensajes entrantes de los últimos **14 días** que, entre
  los mensajes disponibles en Chatwoot, no tengan una salida humana posterior. Se exige
  verificación reciente (máximo 30 minutos). **No infiere automáticamente que 16 chats
  históricos siguen sin atender**. Los estados Pendiente/Abierto de Chatwoot no equivalen
  al estado comercial de la tarea.
- Un nuevo mensaje del cliente genera o actualiza **una tarea automática por conversación**;
  la respuesta posterior del vendedor la completa automáticamente. Se calcula el primer
  vencimiento tras 60 minutos laborales de lunes a viernes, 9–17 Argentina.
- Una demo marcada como realizada y actualizada en los últimos 30 días genera una tarea
  automática de cierre. Las demos anteriores se siguen mostrando en Por cerrar, pero no
  generan alertas antiguas masivas. Al confirmar/perder la oportunidad se cancela la tarea.
- El usuario elige una oportunidad por su **nombre**, o usa «Programar» desde una tarjeta;
  se mantiene la autorización servidor para que un vendedor no cargue tareas de otro.
- Botón «Actualizar Chatwoot» y banner cuando la sincronización está desactualizada o falta
  `CHATWOOT_API_TOKEN`. El cron procesa la siguiente ronda cada cinco minutos.
- Resumen matutino y recordatorio individual a las 11:00 y 15:00, **solo cuando**
  `CRM_ALERTAS_WHATSAPP=true`, el teléfono esté validado y exista al menos una conversación
  comprobada con 60 minutos laborales sin respuesta. Los avisos se deduplican por día.

### Límites a validar en Railway

1. La API de Chatwoot debe devolver `messages`, `meta.sender`, `meta.assignee` y `status`
   para el token configurado; si no, el panel **advierte falta de verificación** en lugar
   de inventar urgencias. No se probó contra la base de producción desde este entorno.
2. No se marca como «humanamente atendido» un mensaje saliente atribuido a un bot o a
   la cuenta administradora técnica. Los vendedores reconocidos en la clasificación son
   los IDs de Chatwoot 4, 8, 11 y 19. Verificar cualquier alta nueva de vendedor.
3. Cambios en reuniones o mensajes que no tengan vínculo con `control_ventas` no entran
   en la ronda inicial de verificación; requieren sincronización de origen.
4. **WhatsApp permanece desactivado** hasta validar remitente y números (Santiago no figura
   en `AGENTE_TELEFONO`), ya que las alertas generan mensajes reales.
5. La sincronización es eventual (cada 5 minutos), no instantánea. También puede
   solicitarse manualmente desde «Actualizar Chatwoot».
