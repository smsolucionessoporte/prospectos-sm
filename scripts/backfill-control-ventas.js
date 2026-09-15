const axios = require("axios");
const { pool } = require("../src/db");

const CHATWOOT_URL = process.env.CHATWOOT_URL;
const ACCOUNT_ID = process.env.CHATWOOT_ACCOUNT_ID || "1";
const TOKEN = process.env.CHATWOOT_API_TOKEN;
const INBOX_ID = 6;

const VENDEDORES = new Map([
  ["giuliano carabajal", { nombre: "Giuliano Carabajal", usuarioId: 12 }],
  ["rafael altadonna", { nombre: "Rafael Altadonna", usuarioId: 8 }],
  ["daniel gonzalez", { nombre: "Daniel Gonzalez", usuarioId: 7 }],
  ["tomas parcel", { nombre: "Tomas Parcel", usuarioId: 11 }],
  ["tomás parcel", { nombre: "Tomas Parcel", usuarioId: 11 }],
]);

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
  const d = new Date(Number(valor) * 1000);
  return Number.isNaN(d.getTime()) ? null : d;
}

function normalizar(valor = "") {
  return String(valor)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase();
}

function detectarOrigen(labels = []) {
  const l = labels.map(normalizar);
  if (l.includes("meta-pos-cliente")) return "meta";
  if (l.includes("google-pos-cliente")) return "google";
  return "otro";
}

function esIncoming(m) {
  return Number(m.message_type) === 0 || normalizar(m.message_type) === "incoming";
}

function esOutgoing(m) {
  return Number(m.message_type) === 1 || normalizar(m.message_type) === "outgoing";
}

function nombreRemitente(m) {
  return m.sender?.name || m.sender?.available_name || m.sender_name || "";
}

function vendedorPorNombre(nombre) {
  return VENDEDORES.get(normalizar(nombre)) || null;
}

function esMensajeDeVendedor(m) {
  if (m.private || !esOutgoing(m)) return false;
  return Boolean(vendedorPorNombre(nombreRemitente(m)));
}

function esMensajeHandoff(m) {
  if (m.private || !esOutgoing(m)) return false;

  // El handoff lo envía el bot. Nunca tomamos como marca de derivación
  // un mensaje escrito por alguno de los vendedores medidos.
  if (vendedorPorNombre(nombreRemitente(m))) return false;

  const t = normalizar(m.content || "");
  return (
    t.includes("ya te derivamos con un asesor") ||
    t.includes("te derivamos con un asesor") ||
    t.includes("te ponemos en contacto con un asesor") ||
    t.includes("derivamos con un asesor comercial") ||
    (t.includes("asesor comercial") && t.includes("a la brevedad"))
  );
}

function detectarClasificacion(mensajes) {
  const incoming = mensajes.filter(
    (m) => !m.private && esIncoming(m) && m.content,
  );

  const textos = incoming.map((m) => normalizar(m.content || ""));

  // Solo intentamos detectar consultas claramente erróneas.
  //
  // En el panel, "No avanzaron" se calculará como:
  // respondió + no es consulta errónea + no fue derivado.
  const consultaErronea = textos.some((t) =>
    /\b(equivocad[oa]|numero equivocado|mensaje equivocado|me equivoque|por error|no corresponde|calculadora|busco trabajo|buscando trabajo|busqueda laboral|curriculum|curriculo|vacante|trabajar con ustedes|soy proveedor|somos proveedores|necesito soporte|soporte tecnico|soy cliente|ya soy cliente|cliente actual)\b/.test(
      t,
    ),
  );

  return consultaErronea ? "consulta_erronea" : null;
}
async function obtenerConversaciones() {
  const todas = [];
  let page = 1;
  while (true) {
    console.log(`Leyendo página ${page} de Chatwoot...`);
    const response = await api.get("/conversations", {
      params: { inbox_id: INBOX_ID, status: "all", assignee_type: "all", page },
    });
    const payload = response.data?.data?.payload || [];
    if (!payload.length) break;
    todas.push(...payload);
    console.log(`  ${payload.length} conversaciones encontradas. Total: ${todas.length}`);
    if (payload.length < 25) break;
    page++;
  }
  return todas;
}

async function obtenerMensajes(conversationId) {
  const todos = [];
  const idsVistos = new Set();

  let before = null;

  while (true) {
    const response = await api.get(
      `/conversations/${conversationId}/messages`,
      {
        params: before ? { before } : {},
      },
    );

    const payload = Array.isArray(response.data?.payload)
      ? response.data.payload
      : Array.isArray(response.data)
        ? response.data
        : [];

    if (!payload.length) break;

    for (const mensaje of payload) {
      const id = Number(mensaje.id);

      if (Number.isFinite(id)) {
        if (idsVistos.has(id)) continue;
        idsVistos.add(id);
      }

      todos.push(mensaje);
    }

    const idsPagina = payload
      .map((mensaje) => Number(mensaje.id))
      .filter((id) => Number.isFinite(id));

    if (!idsPagina.length) break;

    const idMasAntiguo = Math.min(...idsPagina);

    // Evita loops si Chatwoot devuelve nuevamente la misma página.
    if (before !== null && idMasAntiguo >= before) break;

    before = idMasAntiguo;

    // Chatwoot devuelve hasta 20 mensajes por página.
    // Si vinieron menos de 20, llegamos al comienzo.
    if (payload.length < 20) break;
  }

  return todos;
}

async function procesarConversacion(c) {
  const id = Number(c.id);
  const labels = Array.isArray(c.labels) ? c.labels : [];
  const labelsNorm = labels.map(normalizar);
  const origen = detectarOrigen(labels);
  const fechaIngreso = fechaUnix(c.created_at) || new Date();
  const derivado = labelsNorm.includes("derivar-ventas");

  const mensajes = await obtenerMensajes(id);
  mensajes.sort((a, b) => Number(a.created_at || 0) - Number(b.created_at || 0));

  const mensajesCliente = mensajes.filter((m) => !m.private && esIncoming(m) && m.content);
  const clasificacion = detectarClasificacion(mensajes);

  // Si llegó a derivación o clasificación, necesariamente hubo interacción aunque
  // Chatwoot ya no conserve el primer incoming completo en el endpoint histórico.
  const primeraRespuestaCliente = mensajesCliente.length > 1
    ? fechaUnix(mensajesCliente[1].created_at)
    : null;
  const respondioCliente = Boolean(
    primeraRespuestaCliente || derivado || clasificacion,
  );

  // La fecha histórica de derivación sale del mensaje REAL del bot que anuncia
  // "Ya te derivamos con un asesor...". Si hubo más de un handoff, usamos el
  // último: representa la derivación vigente y evita medir desde una derivación
  // anterior. No usamos first_reply_created_at ni una fecha aproximada.
  const handoffs = derivado ? mensajes.filter(esMensajeHandoff) : [];
  const handoff = handoffs.length ? handoffs[handoffs.length - 1] : null;
  const fechaDerivacion = handoff ? fechaUnix(handoff.created_at) : null;

  let vendedor = null;
  let primerMensajeVendedor = null;

  if (derivado) {
    const desde = fechaDerivacion ? fechaDerivacion.getTime() : 0;
    primerMensajeVendedor = mensajes.find((m) => {
      if (!esMensajeDeVendedor(m)) return false;
      const f = fechaUnix(m.created_at);
      return f && f.getTime() >= desde;
    }) || null;

    if (primerMensajeVendedor) {
      vendedor = vendedorPorNombre(nombreRemitente(primerMensajeVendedor));
    }

    if (!vendedor) {
      const nombreAsignado = c.meta?.assignee?.name || c.meta?.assignee?.available_name || "";
      vendedor = vendedorPorNombre(nombreAsignado);
    }
  }

  // Para tiempos y alertas históricas exigimos fecha de handoff confiable.
  const primeraRespuestaVendedor =
    fechaDerivacion && primerMensajeVendedor
      ? fechaUnix(primerMensajeVendedor.created_at)
      : null;

  await pool.query(
    `
    INSERT INTO control_ventas (
      chatwoot_conversation_id, origen, fecha_ingreso,
      respondio_cliente, fecha_primera_respuesta_cliente,
      clasificacion, fecha_clasificacion,
      derivado, fecha_derivacion,
      vendedor_id, vendedor_nombre,
      fecha_primera_respuesta_vendedor,
      creado_en, actualizado_en
    ) VALUES (
      $1::bigint,
      $2::varchar,
      $3::timestamptz,
      $4::boolean,
      $5::timestamptz,
      $6::varchar,
      CASE
        WHEN $6::varchar IS NOT NULL
          THEN COALESCE($5::timestamptz, $3::timestamptz)
        ELSE NULL::timestamptz
      END,
      $7::boolean,
      $8::timestamptz,
      $9::integer,
      $10::varchar,
      $11::timestamptz,
      NOW(),
      NOW()
    )
    ON CONFLICT (chatwoot_conversation_id)
    DO UPDATE SET
      origen = EXCLUDED.origen,
      fecha_ingreso = EXCLUDED.fecha_ingreso,
      respondio_cliente = EXCLUDED.respondio_cliente,
      fecha_primera_respuesta_cliente = COALESCE(
        EXCLUDED.fecha_primera_respuesta_cliente,
        control_ventas.fecha_primera_respuesta_cliente
      ),
      clasificacion = COALESCE(EXCLUDED.clasificacion, control_ventas.clasificacion),
      fecha_clasificacion = CASE
        WHEN EXCLUDED.clasificacion IS NOT NULL
          THEN COALESCE(control_ventas.fecha_clasificacion, EXCLUDED.fecha_clasificacion)
        ELSE control_ventas.fecha_clasificacion
      END,
      derivado = EXCLUDED.derivado,
      fecha_derivacion = EXCLUDED.fecha_derivacion,
      vendedor_id = EXCLUDED.vendedor_id,
      vendedor_nombre = EXCLUDED.vendedor_nombre,
      fecha_primera_respuesta_vendedor = EXCLUDED.fecha_primera_respuesta_vendedor,
      actualizado_en = NOW()
    `,
    [
      id,
      origen,
      fechaIngreso,
      respondioCliente,
      primeraRespuestaCliente,
      clasificacion,
      derivado,
      fechaDerivacion,
      vendedor?.usuarioId || null,
      vendedor?.nombre || null,
      primeraRespuestaVendedor,
    ],
  );

  return {
    id,
    origen,
    clasificacion,
    respondioCliente,
    derivado,
    vendedor: vendedor?.nombre || null,
    tiempoConfiable: Boolean(fechaDerivacion),
    respondioVendedor: Boolean(primeraRespuestaVendedor),
  };
}

async function main() {
  console.log("========================================");
  console.log(" BACKFILL HISTÓRICO - CONTROL DE VENTAS");
  console.log("========================================");

  const conversaciones = await obtenerConversaciones();
  console.log(`\nTotal de conversaciones a procesar: ${conversaciones.length}\n`);

  let procesadas = 0;
  let errores = 0;
  let meta = 0;
  let google = 0;
  let derivadas = 0;
  let conTiempo = 0;
  let consultasErroneas = 0;
  let noAvanzaron = 0;

  for (const conversacion of conversaciones) {
    try {
      const r = await procesarConversacion(conversacion);
      procesadas++;
      if (r.origen === "meta") meta++;
      if (r.origen === "google") google++;
      if (r.derivado) derivadas++;
      if (r.tiempoConfiable) conTiempo++;
      if (r.clasificacion === "consulta_erronea") consultasErroneas++;
        if (
        r.respondioCliente &&
        !r.derivado &&
        r.clasificacion !== "consulta_erronea"
        ) {
        noAvanzaron++;
        }
      console.log(
        `[${procesadas}/${conversaciones.length}] #${r.id}` +
          ` | ${r.origen}` +
          ` | ${r.clasificacion || "sin-clasificar"}` +
          ` | derivado=${r.derivado ? "SI" : "NO"}` +
          ` | vendedor=${r.vendedor || "—"}` +
          ` | tiempo=${r.tiempoConfiable ? "CONFIABLE" : "—"}`,
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
    } catch (err) {
      errores++;
      console.error(`ERROR conversación #${conversacion.id}:`, err.response?.data || err.message);
    }
  }

  const resumen = await pool.query(`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE origen='meta')::int AS meta,
      COUNT(*) FILTER (WHERE origen='google')::int AS google,
      COUNT(*) FILTER (WHERE clasificacion='consulta_erronea')::int AS consultas_erroneas,
      COUNT(*) FILTER (
        WHERE respondio_cliente = true
            AND derivado = false
            AND COALESCE(clasificacion, '') <> 'consulta_erronea'
        )::int AS no_avanzaron,
      COUNT(*) FILTER (WHERE derivado=true)::int AS derivados,
      COUNT(*) FILTER (WHERE derivado=true AND fecha_derivacion IS NOT NULL)::int AS derivaciones_con_hora_confiable,
      COUNT(*) FILTER (WHERE derivado=true AND fecha_primera_respuesta_vendedor IS NOT NULL)::int AS respuestas_con_hora_confiable
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
  console.log(`Derivaciones con hora confiable: ${conTiempo}`);
  console.log(`Consultas erróneas detectadas: ${consultasErroneas}`);
  console.log(`No avanzaron detectados: ${noAvanzaron}`);
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
