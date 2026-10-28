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
