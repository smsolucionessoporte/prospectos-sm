# SM Comercial · Google Meet (29/10/2026)

## Horarios confirmados

- **AM:** lunes a viernes 10:30–11:00 (Buenos Aires): https://meet.google.com/qzr-zuye-wku
- **PM:** lunes a viernes 15:30–16:00 (Buenos Aires): https://meet.google.com/phy-ouvy-ayb
- Cada turno es **grupal** y puede reunir varios prospectos. La inscripción se registra por separado en SM Comercial. Google Calendar **no crea un evento nuevo por cada inscripción**.
- Grabación automática de las series recurrentes: activada por el organizador en Google Calendar/Meet. Comprobar que inicia realmente cuando entra el anfitrión o coanfitrión desde la web y que Drive recibe el archivo.
- Si el turno ocurre en un feriado o se cancela excepcionalmente, suspender las reservas manualmente o notificar a los prospectos. Esta versión **no consulta excepciones de la serie en Google Calendar**.

## Despliegue

1. Hacer copia de seguridad y desplegar **primero SM Comercial** con los archivos cambiados.
2. En Railway `sm-prospectos`, confirmar `CHATWOOT_URL`, `CHATWOOT_ACCOUNT_ID`, `CHATWOOT_API_TOKEN`, `BOT_INBOX_ID`, `AUTOMATION_API_KEY` y `VENTAS_TELEFONO_RAFAEL`, `VENTAS_TELEFONO_GIULIANO`, `VENTAS_TELEFONO_SANTIAGO`.
3. Crear un valor aleatorio de al menos 32 caracteres para `DEMO_BOOKING_SECRET` en **SM Comercial** y mantenerlo privado. Ejemplo generador local: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. No compartir la clave.
4. Confirmar `PUBLIC_BASE_URL=https://prospectos-sm-production.up.railway.app`, `DEMO_TELEFONO_MARISOL`, `DEMO_TELEFONO_ROMAN` si difieren de los teléfonos ya guardados, y que los contactos de destino existen en el inbox de Chatwoot.
5. Desplegar después **chatwoot-sales-bot**; verificar `PROSPECTOS_BASE_URL`, `PROSPECTOS_API_KEY` (= `AUTOMATION_API_KEY` de CRM), `CHATWOOT_ADMIN_API_TOKEN` y los tokens propios de Chatwoot.
6. Confirmar que los dos deploys estén `Active`. El servicio CRM migra `demo_tipo`, `google_event_id`, `demo_solicitud` y crea cola `meet_avisos` al iniciar.
7. Probar un prospecto de prueba: pedir demo en Ventas, recibir enlace personalizado, elegir AM/PM, verificar `demo_coordinada`, historial, Meet correcto, aviso en Chatwoot del cliente y WhatsApp individuales a vendedor, Marisol y Román. Verificar que **no se envía nada a grupos**.
8. Probar `Necesito otro horario`: debe quedar pedido pendiente, sin inventar fecha ni Meet. Coordinar desde ficha → demo → personalizada (ver OAuth abajo).
9. Probar un nuevo contacto que diga `ya tengo el sistema`: debe preguntar confirmación, tras `sí` aplicar `cliente-activo`, publicar nota privada y enviar WhatsApp de Soporte +54 9 11 2287-3021. Probar también `no`, que debe volver al flujo de ventas.

## Reuniones personalizadas (OAuth obligatorio)

Los turnos **grupales no requieren Google API**; usan los dos enlaces configurados.

Para que el CRM cree reuniones **personalizadas** desde la ficha, conectá la cuenta organizadora de Workspace vía Google Cloud, con **Google Calendar API** y **Google Meet REST API** activadas, consentimiento OAuth de usuario y autorización de los permisos:

- `https://www.googleapis.com/auth/calendar.events`
- `https://www.googleapis.com/auth/meetings.space.settings`

Configurar en Railway `sm-prospectos`:

```
GOOGLE_CALENDAR_CLIENT_ID=
GOOGLE_CALENDAR_CLIENT_SECRET=
GOOGLE_CALENDAR_REFRESH_TOKEN=
GOOGLE_CALENDAR_ID=primary
```

El refresh token debe corresponder a la cuenta que organiza las demos, tener **acceso offline** y ambos permisos. No compartir tokens ni claves en el chat ni en el repositorio. En una app de consentimiento OAuth en modo *Testing*, los refresh tokens pueden caducar a los siete días; verificar el estado de publicación antes de producción.

La app crea un evento de 30 minutos con Google Calendar y solicita automáticamente grabación en Google Meet API. **Si la API no devuelve enlace o no permite activar la grabación, la ficha no debe confirmar la demo personalizada y se intenta borrar el evento incompleto.** Esto exige comprobar las autorizaciones en un ensayo real.

La grabación queda en Google Drive del organizador y solo comienza cuando entra el organizador/coorganizador de la forma admitida por Meet. **La API no verifica que una persona se haya conectado ni el archivo final de grabación**; esto se controla después en Drive.

## Gestión y avisos

La reserva web se vincula a la conversación de Chatwoot, deja historial y envía confirmación al cliente y avisos individuales al vendedor y responsables de la demostración mediante una cola reintentable. La app **no puede garantizar entrega de WhatsApp** si Chatwoot/Evolution está desconectado; revisar los registros de `meet_avisos` con estado `fallido`.

*Compatibilidad:* la columna existente `zoom_join_url` continúa guardando la URL de **Google Meet** para que la pantalla y los recordatorios actuales sigan funcionando sin una migración destructiva. No representa un enlace Zoom.
