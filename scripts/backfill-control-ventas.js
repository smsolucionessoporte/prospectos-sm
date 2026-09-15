const axios = require("axios");
const { pool } = require("../src/db");

const CHATWOOT_URL = process.env.CHATWOOT_URL;
const ACCOUNT_ID = process.env.CHATWOOT_ACCOUNT_ID || "1";
const TOKEN = process.env.CHATWOOT_API_TOKEN;
const INBOX_ID = 6;

if (!CHATWOOT_URL || !TOKEN) {
  console.error("Faltan CHATWOOT_URL o CHATWOOT_API_TOKEN.");
  process.exit(1);
}

const api = axios.create({
  baseURL: `${CHATWOOT_URL}/api/v1/accounts/${ACCOUNT_ID}`,
  headers: { api_access_token: TOKEN },
  timeout: 30000,
});

function fechaUnix(valor) {
  if (!valor) return null;
  return new Date(Number(valor) * 1000);
}

function normalizar(valor = "") {
  return String(valor).trim().toLowerCase();
}

function detectarOrigen(labels = []) {
  const l = labels.map(normalizar);

  if (l.includes("meta-pos-cliente")) return "meta";
  if (l.includes("google-pos-cliente")) return "google";

  return "otro";
}

function esMensajeCliente(m) {
  return (
    Number(m.message_type) === 0 ||
    normalizar(m.message_type) === "incoming"
  );
}

function esBot(nombre = "") {
  const n = normalizar(nombre);

  return (
    n.includes("bot ventas") ||
    n.includes("sm bot") ||
    n === "bot"
  );
}

function obtenerNombreRemitente(m) {
  return (
    m.sender?.name ||
    m.sender?.available_name ||
    m.sender_name ||
    null
  );
}

function esMensajeHumano(m) {
  if (m.private) return false;

  const outgoing =
    Number(m.message_type) === 1 ||
    normalizar(m.message_type) === "outgoing";

  if (!outgoing) return false;

  const nombre = obtenerNombreRemitente(m);

  if (!nombre) return false;
  if (esBot(nombre)) return false;

  /*
   * En históricos Chatwoot no siempre expone sender_type
   * de forma uniforme. Si es outgoing y tiene un remitente
   * real que no es el bot, lo consideramos respuesta humana.
   */
  return true;
}

function obtenerIdRemitente(m) {
  return m.sender?.id || m.sender_id || null;
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

async function buscarUsuario(nombre) {
  if (!nombre || esBot(nombre)) return null;

  const result = await pool.query(
    `
    SELECT id
    FROM usuarios
    WHERE activo = true
      AND LOWER(nombre) = LOWER($1)
    LIMIT 1
    `,
    [nombre],
  );

  return result.rows[0]?.id || null;
}

async function procesarConversacion(c) {
  const id = Number(c.id);

  const labels = Array.isArray(c.labels) ? c.labels : [];
  const labelsNormalizados = labels.map(normalizar);

  const origen = detectarOrigen(labels);
  const fechaIngreso = fechaUnix(c.created_at) || new Date();

  const mensajes = await obtenerMensajes(id);

  mensajes.sort(
    (a, b) => Number(a.created_at || 0) - Number(b.created_at || 0),
  );

  // -----------------------------------------
  // RESPUESTA DEL CLIENTE
  // -----------------------------------------

  const mensajesCliente = mensajes.filter(esMensajeCliente);

  const primeraRespuestaCliente =
    mensajesCliente.length > 1
      ? fechaUnix(mensajesCliente[1].created_at)
      : null;

  const respondioCliente = Boolean(primeraRespuestaCliente);

  // -----------------------------------------
  // DERIVACIÓN
  // -----------------------------------------

  const derivado = labelsNormalizados.includes("derivar-ventas");

  // -----------------------------------------
  // RESPUESTAS HUMANAS
  // -----------------------------------------

  const mensajesHumanos = mensajes.filter(esMensajeHumano);

  const primerMensajeHumano =
    mensajesHumanos.length > 0
      ? mensajesHumanos[0]
      : null;

  const primeraRespuestaVendedor =
    primerMensajeHumano
      ? fechaUnix(primerMensajeHumano.created_at)
      : null;

  /*
   * Para el histórico Chatwoot no conserva necesariamente
   * el instante exacto en que se agregó derivar-ventas.
   *
   * first_reply_created_at es la mejor referencia histórica
   * disponible. Si no existe pero sí tenemos respuesta humana,
   * usamos esa fecha para evitar generar una alerta histórica
   * falsa.
   */
  let fechaDerivacion = null;

  if (derivado) {
    fechaDerivacion =
      fechaUnix(c.first_reply_created_at) ||
      primeraRespuestaVendedor ||
      null;
  }

  // -----------------------------------------
  // VENDEDOR
  // -----------------------------------------

  let vendedorNombre = null;
  let vendedorChatwootId = null;

  /*
   * Para históricos preferimos quién realmente respondió.
   * El assignee actual puede haber cambiado después.
   */
  if (primerMensajeHumano) {
    vendedorNombre = obtenerNombreRemitente(primerMensajeHumano);
    vendedorChatwootId = obtenerIdRemitente(primerMensajeHumano);
  }

  /*
   * Si todavía no respondió nadie pero está derivada,
   * usamos el responsable actual para la alerta.
   */
  if (!vendedorNombre && derivado) {
    const assignee = c.meta?.assignee || null;
    const nombreAssignee =
      assignee?.name ||
      assignee?.available_name ||
      null;

    if (nombreAssignee && !esBot(nombreAssignee)) {
      vendedorNombre = nombreAssignee;
      vendedorChatwootId = assignee?.id || null;
    }
  }

  const vendedorId = await buscarUsuario(vendedorNombre);

  // -----------------------------------------
  // UPSERT
  // -----------------------------------------

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

      origen = EXCLUDED.origen,

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
          EXCLUDED.vendedor_id,
          control_ventas.vendedor_id
        ),

      vendedor_nombre =
        COALESCE(
          EXCLUDED.vendedor_nombre,
          control_ventas.vendedor_nombre
        ),

      fecha_primera_respuesta_vendedor =
        COALESCE(
          EXCLUDED.fecha_primera_respuesta_vendedor,
          control_ventas.fecha_primera_respuesta_vendedor
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
  let respondidas = 0;
  let meta = 0;
  let google = 0;

  for (const conversacion of conversaciones) {
    try {
      const r = await procesarConversacion(conversacion);

      procesadas++;

      if (r.derivado) derivadas++;
      if (r.derivado && r.respondioVendedor) respondidas++;
      if (r.origen === "meta") meta++;
      if (r.origen === "google") google++;

      console.log(
        `[${procesadas}/${conversaciones.length}] #${r.id}` +
          ` | ${r.origen}` +
          ` | derivado=${r.derivado ? "SI" : "NO"}` +
          ` | respondió vendedor=${r.respondioVendedor ? "SI" : "NO"}` +
          ` | vendedor=${r.vendedor || "—"}`,
      );

      await new Promise((resolve) => setTimeout(resolve, 100));
    } catch (err) {
      errores++;

      console.error(
        `ERROR conversación #${conversacion.id}:`,
        err.response?.data || err.message,
      );
    }
  }

  const resumen = await pool.query(`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE derivado = true)::int AS derivados,
      COUNT(*) FILTER (
        WHERE derivado = true
          AND fecha_primera_respuesta_vendedor IS NOT NULL
      )::int AS respondidos,
      COUNT(*) FILTER (
        WHERE derivado = true
          AND fecha_primera_respuesta_vendedor IS NULL
      )::int AS pendientes
    FROM control_ventas
  `);

  console.log("\n========================================");
  console.log(" BACKFILL TERMINADO");
  console.log("========================================");
  console.log(`Procesadas: ${procesadas}`);
  console.log(`Errores: ${errores}`);
  console.log(`Meta detectadas: ${meta}`);
  console.log(`Google detectadas: ${google}`);
  console.log(`Derivadas detectadas: ${derivadas}`);
  console.log(`Respondidas detectadas: ${respondidas}`);

  console.log("\nCONTROL_VENTAS:");
  console.table(resumen.rows);
}

main()
  .catch((err) => {
    console.error("ERROR GENERAL:", err.response?.data || err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });