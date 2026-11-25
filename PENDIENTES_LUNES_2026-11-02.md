# Checklist lunes 02/11/2026 — SM Comercial / Chatwoot

Horario operativo de Ventas: lunes a viernes de 09:00 a 17:00 (Argentina).
Derivación inicial y aviso de derivación: inmediato, las 24 horas. Alertas y reasignaciones automáticas por falta de respuesta: solamente en horario laboral.

## Controles prioritarios

- **09:00**: confirmar que los deployments activos son los nuevos, revisar logs de bot y CRM. Verificar que las reasignaciones manuales notificadas fuera de horario hayan quedado pendientes y no se dupliquen; si el nuevo vendedor ya respondió, no notificarlo de nuevo.
- **09:10**: Jesús **#2860**, Santiago. Primera alerta enviada manualmente el viernes y registrada como nivel 1. Si continúa sin respuesta humana, corresponde segunda alerta (nivel 2) a las 09:10. Posible reasignación a las 10:10, únicamente si sigue sin atender, la segunda alerta fue entregada y no cambió responsable.
- **10:00**: Yuaraima **#3150**, Giuliano. Derivación y aviso del viernes entregados manualmente. Primera alerta SLA si no hubo respuesta; segunda alerta a las **11:00**; posible reasignación a las **12:00**. No generar aviso duplicado de derivación.
- Verificar sincronización de conversaciones válidas **#2988, #3041, #2936** y que no haya timeouts persistentes ni errores repetitivos. La #2936 está asignada manualmente a Marisol: no debe generar SLA comercial ni llamadas con su ID al endpoint de vendedores.
- Confirmar con Rafael/Giuliano/Santiago que recibieron alertas con **link directo Chatwoot** y que desaparecen del panel tras una respuesta humana.
- Auditar histórico de Daniel sin reabrir conversaciones cerradas ni cambiar creador histórico o etapas comerciales.

**Nota:** horarios estimados a partir de los estados conocidos del viernes; dependen de que el prospecto siga sin atender, de los estados actuales y de la entrega real de cada aviso. No hay verificación automática en vivo desde este documento.
