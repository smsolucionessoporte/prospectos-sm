const axios = require("axios");
const { pool } = require("../src/db");

const CHATWOOT_URL = process.env.CHATWOOT_URL;
const ACCOUNT_ID = process.env.CHATWOOT_ACCOUNT_ID || "1";
const TOKEN = process.env.CHATWOOT_API_TOKEN;
const INBOX_ID = 6;

if (!CHATWOOT_URL || !TOKEN) {
  console.error(
    "Faltan CHATWOOT_URL o CHATWOOT_API_TOKEN en las variables de entorno.",
  );
  process.exit(1);
}

const api = axios.create({
  baseURL: `${CHATWOOT_URL}/api/v1/accounts/${ACCOUNT_ID}`,
  headers: {
    api_access_token: TOKEN,
  },
  timeout: 30000,
});

function fechaUnix(valor) {
  if (!valor) return null;
  return new Date(Number(valor) * 1000);
}

function detectarOrigen(labels = []) {
  const normalized = labels.map((l) => String(l).toLowerCase());

  if (normalized.includes("meta-pos-cliente")) return "meta";
  if (normalized.includes("google-pos-cliente")) return "google";

  return "otro";
}

function esMensajeCliente(m) {
  return (
    Number(m.message_type) === 0 ||
    String(m.message_type).toLowerCase() === "incoming"
  );
}

function esMensajeHumano(m) {
  if (m.private) return false;

  const outgoing =
    Number(m.message_type) === 1 ||
    String(m.message_type).toLowerCase() === "outgoing";

  if (!outgoing) return false;

  return String(m.sender_type || "").toLowerCase() === "user";
}

async function obtenerConversaciones() {
  const todas = [];
  let page = 1;

  while (true) {
    console.log(`Leyendo página ${page} de Chatwoot...`);

    const response = await api.get("/conversations", {
      params: {
        inbox_id: INBOX_ID,
        status: "all",
        assignee_type: "all",
        page,
      },
    });

    const payload = response.data?.data?.payload || [];

    if (!payload.length) break;

    todas.push(...payload);

    console.log(
      `  ${payload.length} conversaciones encontradas. Total: ${todas.length}`,
    );

    if (payload.length < 25) break;

    page++;
  }

  return todas;
}

async function obtenerMensajes(conversationId) {
  const response = await api.get(
    `/conversations/${conversationId}/messages`,
  );

  const payload = response.data?.payload;

  if (Array.isArray(payload)) return payload;

  if (Array.isArray(response.data)) return response.data;

  return [];
}

async function buscarUsuarioPorChatwoot(agentId, nombre) {
  if (!agentId && !nombre) return null;

  /*
   * Primero intentamos aprovechar los prospectos que ya fueron creados
   * desde Chatwoot y tienen responsable conocido.
   */
  if (agentId) {
    const porProspecto = await pool.query(
      `
      SELECT u.id
      FROM prospectos p
      JOIN usuarios u ON u.id = COALESCE(p.demo_responsable, p.creado_por)
      WHERE p.chatwoot_conversation_id IS NOT NULL
        AND u.activo = true
        AND LOWER(u.nombre) = LOWER($1)
      LIMIT 1
      `,
      [nombre || ""],
    );

    if (porProspecto.rows.length) {
      return porProspecto.rows[0].id;
    }
  }

  if (nombre) {
    const porNombre = await pool.query(
      `
      SELECT id
      FROM usuarios
      WHERE activo = true
        AND LOWER(nombre) = LOWER($1)
      LIMIT 1
      `,
      [nombre],
    );

    if (porNombre.rows.length) {
      return porNombre.rows[0].id;
    }
  }

  return null;
}

async function procesarConversacion(c) {
  const id = Number(c.id);

  const labels = Array.isArray(c.labels) ? c.labels : [];
  const origen = detectarOrigen(labels);

  const fechaIngreso = fechaUnix(c.created_at) || new Date();

  const mensajes = await obtenerMensajes(id);

  mensajes.sort(
    (a, b) => Number(a.created_at || 0) - Number(b.created_at || 0),
  );

  const mensajesCliente = mensajes.filter(esMensajeCliente);

  /*
   * El primer mensaje es el ingreso del contacto.
   * Si hay otro incoming posterior, consideramos que respondió al bot.
   */
  const primeraRespuestaCliente =
    mensajesCliente.length > 1
      ? fechaUnix(mensajesCliente[1].created_at)
      : null;

  const respondioCliente = Boolean(primeraRespuestaCliente);

  const derivado = labels
    .map((l) => String(l).toLowerCase())
    .includes("derivar-ventas");

  const assignee = c.meta?.assignee || null;
  const vendedorNombre =
    assignee?.name || assignee?.available_name || null;

  const vendedorId = await buscarUsuarioPorChatwoot(
    assignee?.id || null,
    vendedorNombre,
  );

  const mensajesHumanos = mensajes.filter(esMensajeHumano);

  const primeraRespuestaVendedor =
    mensajesHumanos.length > 0
      ? fechaUnix(mensajesHumanos[0].created_at)
      : null;

  /*
   * Chatwoot no nos entrega directamente la fecha histórica en que
   * se agregó derivar-ventas.
   *
   * Para históricos usamos como mejor aproximación:
   * - first_reply_created_at, si existe;
   * - primera respuesta humana;
   *
   * Nunca usamos una fecha posterior a la primera respuesta humana.
   *
   * Los registros nuevos del bot ya tienen fecha_derivacion exacta
   * y el ON CONFLICT de abajo NO la pisa.
   */
  let fechaDerivacion = null;

  if (derivado) {
    fechaDerivacion =
      fechaUnix(c.first_reply_created_at) ||
      primeraRespuestaVendedor ||
      null;
  }

  await pool.query(
    `
    INSERT INTO control_ventas (
      chatwoot_conversation_id,
      origen,
      fecha_ingreso,
      respondio_cliente,
      fecha_primera_respuesta_cliente,
      derivado,
      fecha_derivacion,
      vendedor_id,
      vendedor_nombre,
      fecha_primera_respuesta_vendedor,
      creado_en,
      actualizado_en
    )
    VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW(),NOW()
    )

    ON CONFLICT (chatwoot_conversation_id)
    DO UPDATE SET

      origen =
        CASE
          WHEN control_ventas.origen IS NULL
            OR control_ventas.origen = 'otro'
          THEN EXCLUDED.origen
          ELSE control_ventas.origen
        END,

      fecha_ingreso =
        COALESCE(
          control_ventas.fecha_ingreso,
          EXCLUDED.fecha_ingreso
        ),

      respondio_cliente =
        control_ventas.respondio_cliente
        OR EXCLUDED.respondio_cliente,

      fecha_primera_respuesta_cliente =
        COALESCE(
          control_ventas.fecha_primera_respuesta_cliente,
          EXCLUDED.fecha_primera_respuesta_cliente
        ),

      derivado =
        control_ventas.derivado
        OR EXCLUDED.derivado,

      fecha_derivacion =
        COALESCE(
          control_ventas.fecha_derivacion,
          EXCLUDED.fecha_derivacion
        ),

      vendedor_id =
        COALESCE(
          control_ventas.vendedor_id,
          EXCLUDED.vendedor_id
        ),

      vendedor_nombre =
        COALESCE(
          control_ventas.vendedor_nombre,
          EXCLUDED.vendedor_nombre
        ),

      fecha_primera_respuesta_vendedor =
        COALESCE(
          control_ventas.fecha_primera_respuesta_vendedor,
          EXCLUDED.fecha_primera_respuesta_vendedor
        ),

      actualizado_en = NOW()
    `,
    [
      id,
      origen,
      fechaIngreso,
      respondioCliente,
      primeraRespuestaCliente,
      derivado,
      fechaDerivacion,
      vendedorId,
      vendedorNombre,
      primeraRespuestaVendedor,
    ],
  );

  return {
    id,
    origen,
    respondioCliente,
    derivado,
    vendedor: vendedorNombre,
    respondioVendedor: Boolean(primeraRespuestaVendedor),
  };
}

async function main() {
  console.log("========================================");
  console.log(" BACKFILL HISTÓRICO - CONTROL DE VENTAS");
  console.log("========================================");

  const conversaciones = await obtenerConversaciones();

  console.log(
    `\nTotal de conversaciones a procesar: ${conversaciones.length}\n`,
  );

  let procesadas = 0;
  let errores = 0;
  let derivadas = 0;
  let meta = 0;
  let google = 0;

  for (const conversacion of conversaciones) {
    try {
      const resultado = await procesarConversacion(conversacion);

      procesadas++;

      if (resultado.derivado) derivadas++;
      if (resultado.origen === "meta") meta++;
      if (resultado.origen === "google") google++;

      console.log(
        `[${procesadas}/${conversaciones.length}] #${resultado.id}` +
          ` | ${resultado.origen}` +
          ` | derivado=${resultado.derivado ? "SI" : "NO"}` +
          ` | vendedor=${resultado.vendedor || "—"}`,
      );

      // Evitamos castigar innecesariamente la API.
      await new Promise((resolve) => setTimeout(resolve, 100));
    } catch (err) {
      errores++;

      console.error(
        `ERROR conversación #${conversacion.id}:`,
        err.response?.data || err.message,
      );
    }
  }

  const totalControl = await pool.query(
    `SELECT COUNT(*)::int AS total FROM control_ventas`,
  );

  console.log("\n========================================");
  console.log(" BACKFILL TERMINADO");
  console.log("========================================");
  console.log(`Procesadas: ${procesadas}`);
  console.log(`Errores: ${errores}`);
  console.log(`Meta detectadas: ${meta}`);
  console.log(`Google detectadas: ${google}`);
  console.log(`Derivadas detectadas: ${derivadas}`);
  console.log(
    `Registros actuales en control_ventas: ${totalControl.rows[0].total}`,
  );
}

main()
  .catch((err) => {
    console.error("ERROR GENERAL:", err.response?.data || err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });