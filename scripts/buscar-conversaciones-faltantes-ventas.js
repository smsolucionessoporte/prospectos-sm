const axios = require("axios");
const { pool } = require("../src/db");

const CHATWOOT_URL = process.env.CHATWOOT_URL;
const CHATWOOT_ACCOUNT_ID = process.env.CHATWOOT_ACCOUNT_ID;
const CHATWOOT_API_TOKEN = process.env.CHATWOOT_API_TOKEN;
const INBOX_ID = Number(process.env.CHATWOOT_INBOX_ID_VENTAS);

async function getConversacionesPagina(page) {
  const response = await axios.get(
    `${CHATWOOT_URL}/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/conversations`,
    {
      headers: {
        api_access_token: CHATWOOT_API_TOKEN,
      },
      params: {
        inbox_id: INBOX_ID,
        status: "all",
        page,
      },
    },
  );

  return response.data;
}

async function main() {
  if (
    !CHATWOOT_URL ||
    !CHATWOOT_ACCOUNT_ID ||
    !CHATWOOT_API_TOKEN ||
    !INBOX_ID
  ) {
    throw new Error(
      "Faltan variables de Chatwoot o CHATWOOT_INBOX_ID_VENTAS",
    );
  }

  const controlResult = await pool.query(`
    SELECT chatwoot_conversation_id
    FROM control_ventas
    WHERE chatwoot_conversation_id IS NOT NULL
  `);

  const prospectosResult = await pool.query(`
    SELECT chatwoot_conversation_id
    FROM prospectos
    WHERE chatwoot_conversation_id IS NOT NULL
  `);

  const controlIds = new Set(
    controlResult.rows.map((r) =>
      Number(r.chatwoot_conversation_id),
    ),
  );

  const prospectosIds = new Set(
    prospectosResult.rows.map((r) =>
      Number(r.chatwoot_conversation_id),
    ),
  );

  const conversaciones = [];

  let page = 1;

  while (true) {
    const data = await getConversacionesPagina(page);

    const payload = Array.isArray(data?.data?.payload)
      ? data.data.payload
      : Array.isArray(data?.payload)
        ? data.payload
        : [];

    if (!payload.length) {
      break;
    }

    for (const conversation of payload) {
      const inboxId =
        conversation.inbox_id ??
        conversation.inbox?.id ??
        null;

      if (Number(inboxId) === INBOX_ID) {
        conversaciones.push(conversation);
      }
    }

    page++;

    if (page > 100) {
      break;
    }
  }

  const faltantes = [];

  for (const conversation of conversaciones) {
    const id = Number(conversation.id);

    const estaControl = controlIds.has(id);
    const estaProspectos = prospectosIds.has(id);

    if (!estaControl && !estaProspectos) {
      const labels = Array.isArray(conversation.labels)
        ? conversation.labels
        : [];

      faltantes.push({
        conversacion: id,
        contacto:
          conversation.meta?.sender?.name ??
          conversation.contact?.name ??
          "",
        control: "NO",
        prospectos: "NO",
        etiquetas: labels.join(", "),
      });
    }
  }

  console.log("\n===== CANAL WHATSAPP-VENTAS =====");
  console.log(
    `Conversaciones encontradas en Chatwoot: ${conversaciones.length}`,
  );

  console.log(
    `Sin Control ni Prospectos: ${faltantes.length}`,
  );

  if (faltantes.length) {
    console.log("\n===== FALTANTES =====\n");
    console.table(faltantes);
  } else {
    console.log(
      "\nNo hay conversaciones fuera de Control/Prospectos.",
    );
  }
}

main()
  .catch((err) => {
    console.error(err.response?.data || err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });