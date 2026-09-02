const axios = require('axios');
const { AGENTE_INBOX, AGENTE_CHATWOOT_ID } = require('./zoomAgentes');

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

const CONVERSACION_AVISOS_ID = Number(process.env.CONVERSACION_AVISOS_ID);

async function enviarAvisoInterno(mensaje) {
  if (!CONVERSACION_AVISOS_ID) {
    console.log('CONVERSACION_AVISOS_ID no configurado');
    return false;
  }

  await enviarMensajePorConversationId(
    CONVERSACION_AVISOS_ID,
    mensaje
  );

  return true;
}

async function enviarMensajePorConversationId(conversationId, mensaje) {
  await axios.post(
    `${process.env.CHATWOOT_URL}/api/v1/accounts/${process.env.CHATWOOT_ACCOUNT_ID}/conversations/${conversationId}/messages`,
    { content: mensaje, message_type: 'outgoing' },
    { headers: { api_access_token: process.env.CHATWOOT_API_TOKEN } }
  );
}

const BOT_INBOX_ID = Number(process.env.BOT_INBOX_ID);

async function enviarPorChatwoot(telefono, mensaje, usuarioId, origen = null) {

      const inboxId = BOT_INBOX_ID;

        if (!inboxId) {
          console.log('BOT_INBOX_ID no configurado');
          return false;
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
    c => Number(c.inbox_id) === Number(inboxId)
  );


    // Reabrir únicamente conversaciones realmente resueltas.
    // Si está pendiente, respetar el estado elegido por el agente.
    if (conversation && conversation.status === 'resolved') {

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


// Si no existe conversación en Bot Ventas, asegurar que el contacto
// esté vinculado a ese inbox y crear la conversación.
if (!conversation) {

  let sourceId;

  try {
    const { data: contactInbox } = await axios.post(
      `${process.env.CHATWOOT_URL}/api/v1/accounts/${process.env.CHATWOOT_ACCOUNT_ID}/contacts/${contacto.id}/contact_inboxes`,
      {
        inbox_id: inboxId,
        source_id: telefono
      },
      {
        headers: {
          api_access_token: process.env.CHATWOOT_API_TOKEN
        }
      }
    );

    sourceId = contactInbox.source_id;

  } catch (error) {

    // Si el vínculo contacto/inbox ya existe, volvemos a consultar
    // las conversaciones por si Chatwoot ya creó/reconoce una.
    const { data: retryConvData } = await axios.get(
      `${process.env.CHATWOOT_URL}/api/v1/accounts/${process.env.CHATWOOT_ACCOUNT_ID}/contacts/${contacto.id}/conversations`,
      {
        headers: {
          api_access_token: process.env.CHATWOOT_API_TOKEN
        }
      }
    );

    conversation = retryConvData.payload?.find(
      c => Number(c.inbox_id) === Number(inboxId)
    );

    if (!conversation) {
      console.error(
        "No se pudo vincular el contacto al inbox Bot Ventas:",
        error.response?.data || error.message
      );
      return false;
    }
  }

  if (!conversation && sourceId) {
    const { data } = await axios.post(
      `${process.env.CHATWOOT_URL}/api/v1/accounts/${process.env.CHATWOOT_ACCOUNT_ID}/conversations`,
      {
        source_id: sourceId,
        inbox_id: Number(inboxId),
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
}

// Buscar el ID de Chatwoot correspondiente al usuario responsable de Prospectos
const chatwootAgentId = Number(
  Object.keys(AGENTE_CHATWOOT_ID).find(
    id => Number(AGENTE_CHATWOOT_ID[id]) === Number(usuarioId)
  )
);

      // Asignar la conversación al responsable
      if (chatwootAgentId) {
        await axios.post(
          `${process.env.CHATWOOT_URL}/api/v1/accounts/${process.env.CHATWOOT_ACCOUNT_ID}/conversations/${conversation.id}/assignments`,
          {
            assignee_id: chatwootAgentId
          },
          {
            headers: {
              api_access_token: process.env.CHATWOOT_API_TOKEN
            }
          }
        );
      }

            // Marcar como atención humana y evitar que intervenga Bot Ventas
      try {
        const { data: labelsData } = await axios.get(
          `${process.env.CHATWOOT_URL}/api/v1/accounts/${process.env.CHATWOOT_ACCOUNT_ID}/conversations/${conversation.id}/labels`,
          {
            headers: {
              api_access_token: process.env.CHATWOOT_API_TOKEN
            }
          }
        );

        const labelsActuales = labelsData.payload || [];

        const nuevasLabels = [
          ...labelsActuales.filter(label => label !== 'bot-activo'),
          'derivar-ventas'
        ];

        await axios.post(
          `${process.env.CHATWOOT_URL}/api/v1/accounts/${process.env.CHATWOOT_ACCOUNT_ID}/conversations/${conversation.id}/labels`,
          {
            labels: [...new Set(nuevasLabels)]
          },
          {
            headers: {
              api_access_token: process.env.CHATWOOT_API_TOKEN
            }
          }
        );

      } catch (error) {
        console.error(
          'ERROR actualizando etiquetas de Chatwoot:',
          error.response?.data || error.message
        );
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