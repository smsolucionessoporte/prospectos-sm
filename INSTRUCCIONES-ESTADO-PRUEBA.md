# SM Comercial — Estado Prueba (7 días)

## Instalación

Copiar únicamente los archivos incluidos en este ZIP respetando las rutas del proyecto `sm-prospectos`.
El servicio debe ejecutar `src/index.js`, como hasta ahora. No hay variables nuevas ni que ejecutar SQL manualmente: el esquema adicional se prepara al iniciar, después de las migraciones existentes.

## Operación

1. Abrir una ficha en estado **Demo realizada** y pulsar **Activar prueba (7 días)** exclusivamente cuando el sistema de prueba ya esté instalado/activado.
2. El sistema guarda el inicio y el vencimiento a los **7 días corridos** (misma hora, en zona Argentina), el historial y el seguimiento del responsable con prioridad alta.
3. Registra dos avisos iniciales independientes: cliente y vendedor/responsable; intenta enviarlos por Chatwoot inmediatamente. La pantalla informa si se confirmaron o si están pendientes. Los fallos no revierten la activación ni repiten el cambio de estado.
4. El seguimiento queda visible en la agenda con el reloj. Al cumplirse el plazo, el estado continúa siendo **Prueba**, pero se presenta **Prueba vencida**. Se notificará al cliente y al responsable en el siguiente horario laboral (lunes a viernes, 9 a 17, Buenos Aires).
5. El vendedor cambia la oportunidad a **Confirmado** o **Perdido**; al cerrarse antes de la expiración, las notificaciones de expiración pendientes se omiten.

**La fecha de CRM NO desactiva una licencia instalada**: el bloqueo/renovación técnica requiere integración adicional con el licenciamiento real.

Las notificaciones de prueba son específicas del cambio de estado y **no dependen de `CRM_ALERTAS_WHATSAPP`**. Se envían individualmente; nunca a grupos. Deben estar configuradas las variables de Chatwoot y los teléfonos individuales.

## Comprobación de entrega en PostgreSQL

```sql
SELECT p.id, p.nombre_negocio, p.estado, p.prueba_inicio, p.prueba_vence,
       a.tipo, a.estado AS aviso_estado, a.intentos, a.enviado_en, a.error
FROM prospectos p
LEFT JOIN crm_prueba_avisos a ON a.prospecto_id=p.id
WHERE p.id = REEMPLAZAR_ID
ORDER BY a.tipo;
```

Estados de aviso: `pendiente`, `enviando`, `enviado`, `error`, `omitido`.
Los fallos se reintentan cada 10 minutos (hasta 10 intentos) por un procesador que revisa cada 2 minutos.
La entrega confirmada por Chatwoot no garantiza lectura efectiva en WhatsApp.

## Prueba controlada previa al uso real

Crear una ficha de prueba con teléfono autorizado de testing, completar el relevamiento hasta **Demo realizada** y activar **Prueba**. Verificar: una sola activación, fecha +7 días, aparición en Agenda, ambos mensajes, historial y estados de la tabla `crm_prueba_avisos`. Luego marcar Perdido y comprobar que no se envíe el vencimiento al llegar el plazo.

## Alcance de la validación

Compilación sintáctica de los JavaScript modificados y 60 pruebas locales aprobadas. **No se comprobó el envío real a WhatsApp, la migración en PostgreSQL de producción ni el vencimiento cron de 7 días en Railway.**
