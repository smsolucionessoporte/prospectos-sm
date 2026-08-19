const axios = require('axios');
const { AGENTE_INBOX } = require('./zoomAgentes'); 

async function getZoomToken() {
  const auth = Buffer.from(`${process.env.ZOOM_CLIENT_ID}:${process.env.ZOOM_CLIENT_SECRET}`).toString('base64');
  const { data } = await axios.post('https://zoom.us/oauth/token', null, {
    params: { grant_type: 'account_credentials', account_id: process.env.ZOOM_ACCOUNT_ID },
    headers: { Authorization: `Basic ${auth}` }
  });
  return data.access_token;
}

function formatearFechaAR(demoFechaStr) {
  // demoFechaStr viene como "2026-07-05T23:00" (hora de Buenos Aires, sin zona)
  const [fecha, hora] = demoFechaStr.split('T');
  const [anio, mes, dia] = fecha.split('-');
  const [hh, mm] = hora.split(':');
  const dias = ['domingo','lunes','martes','miércoles','jueves','viernes','sábado'];
  const meses = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
  // Creamos la fecha SOLO para saber el día de la semana, tratándola como si fuera UTC (evita el corrimiento)
  const fechaUTC = new Date(`${fecha}T${hora}:00Z`);
  const diaSemana = dias[fechaUTC.getUTCDay()];
  return `${diaSemana} ${dia} de ${meses[parseInt(mes)-1]} a las ${hh}:${mm}`;
}

async function crearReunionZoom(zoomEmail, topic, startTimeISO) {
  const token = await getZoomToken();
  // Zoom espera "yyyy-MM-ddTHH:mm:ss" (con segundos). El input datetime-local
  // llega sin segundos ("2026-07-05T22:40"), y si el formato no matchea,
  // Zoom lo ignora silenciosamente y usa la hora de creación como default.
  const startTimeCompleto = /T\d{2}:\d{2}$/.test(startTimeISO)
    ? `${startTimeISO}:00`
    : startTimeISO;

  const { data } = await axios.post(
    `https://api.zoom.us/v2/users/${zoomEmail}/meetings`,
    { topic, type: 2, start_time: startTimeCompleto, timezone: 'America/Argentina/Buenos_Aires', duration: 30 },
    { headers: { Authorization: `Bearer ${token}` } }
  );
  return data.join_url;
}

function normalizarTelefono(tel) {
  const limpio = tel.replace(/[\s\-()]/g, ''); // saca espacios, guiones, paréntesis
  const variantes = [limpio];
  // Si es +54 sin el 9, agregar la variante con 9
  if (limpio.startsWith('+54') && !limpio.startsWith('+549')) {
    variantes.push('+549' + limpio.slice(3));
  }
  // Si ya tiene +549, agregar la variante sin el 9 también
  if (limpio.startsWith('+549')) {
    variantes.push('+54' + limpio.slice(4));
  }
  return variantes;
}

async function enviarMensajePorConversationId(conversationId, mensaje) {
  await axios.post(
    `${process.env.CHATWOOT_URL}/api/v1/accounts/${process.env.CHATWOOT_ACCOUNT_ID}/conversations/${conversationId}/messages`,
    { content: mensaje, message_type: 'outgoing' },
    { headers: { api_access_token: process.env.CHATWOOT_API_TOKEN } }
  );
}

const BOT_INBOX_ID = process.env.BOT_INBOX_ID; // ID del inbox del canal del bot en Chatwoot

async function enviarPorChatwoot(telefono, mensaje, usuarioId) {

      const inboxId = BOT_INBOX_ID;

        if (!inboxId) {
          console.log('BOT_INBOX_ID no configurado');
          return false;
        }

  const NUMERO_AVISOS = '+5491132780621';

async function enviarAvisoInterno(mensaje) {
  return enviarPorChatwoot(NUMERO_AVISOS, mensaje, null);
}

  const variantes = normalizarTelefono(telefono);
  let contacto = null;

  for (const variante of variantes) {
    const { data } = await axios.get(
      `${process.env.CHATWOOT_URL}/api/v1/accounts/${process.env.CHATWOOT_ACCOUNT_ID}/contacts/search?q=${encodeURIComponent(variante)}`,
      {
        headers: {
          api_access_token: process.env.CHATWOOT_API_TOKEN
        }
      }
    );

    if (data.payload?.length) {
      contacto = data.payload[0];
      break;
    }
  }

  if (!contacto) {
    console.error(`No se encontró contacto ${telefono}`);
    return false;
  }


  const { data: convData } = await axios.get(
    `${process.env.CHATWOOT_URL}/api/v1/accounts/${process.env.CHATWOOT_ACCOUNT_ID}/contacts/${contacto.id}/conversations`,
    {
      headers: {
        api_access_token: process.env.CHATWOOT_API_TOKEN
      }
    }
  );


  let conversation = convData.payload?.find(
    c => c.inbox_id === inboxId
  );


  // Si existe pero está cerrada, abrirla
  if (conversation && conversation.status !== 'open') {

    await axios.post(
      `${process.env.CHATWOOT_URL}/api/v1/accounts/${process.env.CHATWOOT_ACCOUNT_ID}/conversations/${conversation.id}/toggle_status`,
      {
        status: "open"
      },
      {
        headers: {
          api_access_token: process.env.CHATWOOT_API_TOKEN
        }
      }
    );

  }


  // Si no existe conversación, crearla
  if (!conversation) {

    const { data } = await axios.post(
      `${process.env.CHATWOOT_URL}/api/v1/accounts/${process.env.CHATWOOT_ACCOUNT_ID}/conversations`,
      {
        source_id: contacto.source_id,
        inbox_id: inboxId,
        contact_id: contacto.id,
        status: "open"
      },
      {
        headers: {
          api_access_token: process.env.CHATWOOT_API_TOKEN
        }
      }
    );

    conversation = data;
  }


  await axios.post(
    `${process.env.CHATWOOT_URL}/api/v1/accounts/${process.env.CHATWOOT_ACCOUNT_ID}/conversations/${conversation.id}/messages`,
    {
      content: mensaje,
      message_type: 'outgoing'
    },
    {
      headers: {
        api_access_token: process.env.CHATWOOT_API_TOKEN
      }
    }
  );


  return true;
}



module.exports = { crearReunionZoom, enviarPorChatwoot, formatearFechaAR, enviarMensajePorConversationId, normalizarTelefono, enviarAvisoInterno };