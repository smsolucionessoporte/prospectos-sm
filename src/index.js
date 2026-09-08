require('dotenv').config();
const express = require('express');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const cron = require('node-cron');
const { pool, runMigrations } = require('./db');
const authRoutes = require('./routes/auth');
const panelRoutes = require('./routes/panel');
const prospectosRoutes = require('./routes/prospectos');
const { enviarPorChatwoot, enviarAvisoInterno, formatearFechaAR } = require('./zoomChatwoot');
const { responsableCierre } = require('./routes/prospectos');
const { AGENTE_ZOOM, AGENTE_TELEFONO, AGENTE_INBOX, AGENTE_CHATWOOT_ID } = require('./zoomAgentes');
const { registrarRutasZoomGiuliano } = require('./zoomGiuliano');


const app = express();
const PORT = process.env.PORT || 3000;
app.set('trust proxy', 1); //
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static('public'));

// Callback OAuth de la cuenta Zoom independiente de Giuliano
registrarRutasZoomGiuliano(app);

app.use(session({
  store: new pgSession({ pool, tableName: 'session' }),
  secret: process.env.SESSION_SECRET || 'SM-SM-secret-local',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 días
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
  }
}));

app.use(authRoutes);
app.use(panelRoutes);
app.use(prospectosRoutes);

// Redirigir raíz al panel
app.get('/', (req, res) => res.redirect('/panel'));

async function start() {
  try {
    await runMigrations();
    await seedAdminIfNeeded();
    app.listen(PORT, () => {
      console.log(`✓ Servidor corriendo en http://localhost:${PORT}`);
    });
    iniciarRecordatorios();
    iniciarRecordatoriosRelevamiento();
    iniciarResumenDiario();
  } catch (err) {
    console.error('Error al iniciar:', err);
    process.exit(1);
  }
}

// Crear usuario admin inicial si no existe
async function seedAdminIfNeeded() {
  const bcrypt = require('bcryptjs');
  const { rows } = await pool.query('SELECT id FROM usuarios LIMIT 1');
  if (rows.length === 0) {
    const hash = await bcrypt.hash(process.env.ADMIN_PASSWORD || 'admin123', 10);
    await pool.query(`
      INSERT INTO usuarios (nombre, email, password_hash, rol)
      VALUES ('Administrador', $1, $2, 'admin')
    `, [process.env.ADMIN_EMAIL || 'admin@SMsoluciones.com', hash]);
    console.log('✓ Usuario admin creado:', process.env.ADMIN_EMAIL || 'admin@SMsoluciones.com');
    console.log('  Contraseña:', process.env.ADMIN_PASSWORD || 'admin123');
    console.log('  ⚠️  Cambiá la contraseña después del primer login!');
  }
}

// Revisa cada 5 min si hay demos a 2hs de empezar y manda el recordatorio
function iniciarRecordatorios() {
  setInterval(async () => {
    try {
      const { rows } = await pool.query(`
        SELECT p.*, u.nombre as demo_resp_nombre
        FROM prospectos p
        LEFT JOIN usuarios u ON p.demo_responsable = u.id
        WHERE COALESCE(p.recordatorio_enviado, false) = false
          AND p.demo_fecha IS NOT NULL
          AND (p.demo_fecha AT TIME ZONE 'America/Argentina/Buenos_Aires') > now()
          AND (p.demo_fecha AT TIME ZONE 'America/Argentina/Buenos_Aires') <= now() + interval '2 hours'
      `);

      for (const p of rows) {
        const fechaFormateada = formatearFechaAR(
          p.demo_fecha.toISOString().slice(0, 16)
        );

        const linkZoom = p.zoom_join_url
          ? `\n🔗 ${p.zoom_join_url}`
          : '';

        const mensaje = `*Msj automático*

¡Hola! 👋 Te recordamos que en 2 horas tenés programada la demostración de nuestro sistema de gestión. 🎥

📅 ${fechaFormateada}${linkZoom}

💻 Te recomendamos conectarte desde una computadora, con audio y micrófono habilitados.`;

        const enviado = await enviarPorChatwoot(
          p.telefono,
          mensaje,
          p.demo_responsable
        );

        if (enviado) {
          await pool.query(
            'UPDATE prospectos SET recordatorio_enviado = true WHERE id = $1',
            [p.id]
          );

          console.log(
            '✓ Recordatorio de demo enviado:',
            p.id,
            '| zoom:',
            Boolean(p.zoom_join_url)
          );
        } else {
          console.error(
            'No se pudo enviar recordatorio de demo:',
            p.id
          );
        }
      }
    } catch (err) {
      console.error(
        'Error en recordatorios:',
        err.response?.data || err.message || err
      );
    }
  }, 5 * 60 * 1000);
}

// ─── RECORDATORIO POST-DEMO AL RESPONSABLE ────────────────────────────────
// Revisa cada 5 minutos las demos que terminaron hace al menos 1 hora.
// Si todavía no se cargó el relevamiento, avisa una sola vez al responsable.
function iniciarRecordatoriosRelevamiento() {
  setInterval(async () => {
    try {
      const { rows } = await pool.query(`
        SELECT
          p.*,
          u.nombre AS responsable_nombre
        FROM prospectos p
        LEFT JOIN usuarios u
          ON u.id = COALESCE(p.demo_responsable, p.creado_por)
        WHERE p.estado = 'demo_coordinada'
          AND p.demo_fecha IS NOT NULL
          AND p.relevamiento_fecha IS NULL
          AND COALESCE(p.recordatorio_relevamiento_enviado, false) = false
          AND (p.demo_fecha AT TIME ZONE 'America/Argentina/Buenos_Aires')
              <= now() - interval '1 hour'
      `);

      for (const p of rows) {
        const responsableId =
          p.demo_responsable || p.creado_por;

        const telefonoResponsable =
          AGENTE_TELEFONO[responsableId];

        if (!telefonoResponsable) {
          console.error(
            'No hay teléfono configurado para recordatorio post-demo:',
            responsableId,
            '| prospecto:',
            p.id
          );
          continue;
        }

        const nombreProspecto =
          p.nombre_negocio ||
          p.contacto ||
          `Prospecto #${p.id}`;

        const fechaDemo = new Date(p.demo_fecha).toLocaleString(
          'es-AR',
          {
            day: '2-digit',
            month: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            timeZone: 'America/Argentina/Buenos_Aires',
          }
        );

        const mensaje = `📋 *Recordatorio de relevamiento*

La demostración de *${nombreProspecto}* estaba programada para ${fechaDemo} y todavía figura pendiente de relevamiento.

Acordate de cargar el resultado de la demo en Prospectos.`;

        try {
          const enviado = await enviarPorChatwoot(
            telefonoResponsable,
            mensaje,
            responsableId
          );

          if (enviado) {
            await pool.query(
              `
              UPDATE prospectos
              SET recordatorio_relevamiento_enviado = true
              WHERE id = $1
              `,
              [p.id]
            );

            console.log(
              '✓ Recordatorio post-demo enviado:',
              p.id,
              '| responsable:',
              responsableId
            );
          } else {
            console.error(
              'No se pudo enviar recordatorio post-demo:',
              p.id
            );
          }
        } catch (err) {
          console.error(
            'Error enviando recordatorio post-demo:',
            p.id,
            err.response?.data || err.message || err
          );
        }
      }
    } catch (err) {
      console.error(
        'Error buscando demos pendientes de relevamiento:',
        err.response?.data || err.message || err
      );
    }
  }, 5 * 60 * 1000);
}


// ─── RESUMEN DIARIO INDIVIDUAL POR RESPONSABLE ────────────────────────────
function iniciarResumenDiario() {
  cron.schedule(
    '0 9 * * 1-5',
    () => {
      enviarResumenDiario();
    },
    { timezone: 'America/Argentina/Buenos_Aires' }
  );
}

async function enviarResumenDiario() {
  try {
    const { rows } = await pool.query(`
      SELECT
        p.*,
        u.nombre AS responsable_nombre
      FROM prospectos p
      LEFT JOIN usuarios u
        ON u.id = COALESCE(p.demo_responsable, p.creado_por)
      WHERE p.estado IN (
        'prospecto',
        'demo_coordinada',
        'demo_realizada'
      )
      ORDER BY
        COALESCE(p.demo_responsable, p.creado_por),
        CASE p.estado
          WHEN 'prospecto' THEN 1
          WHEN 'demo_coordinada' THEN 2
          WHEN 'demo_realizada' THEN 3
          ELSE 4
        END,
        p.demo_fecha NULLS LAST,
        p.creado_en
    `);

    if (!rows.length) return;

    const porResponsable = {};

    for (const p of rows) {
      const responsableId =
        p.demo_responsable || p.creado_por;

      if (!responsableId) continue;

      if (!porResponsable[responsableId]) {
        porResponsable[responsableId] = {
          nombre: p.responsable_nombre || 'Responsable',
          prospectos: [],
          demos: [],
          cierres: [],
        };
      }

      if (p.estado === 'prospecto') {
        porResponsable[responsableId].prospectos.push(p);
      } else if (p.estado === 'demo_coordinada') {
        porResponsable[responsableId].demos.push(p);
      } else if (p.estado === 'demo_realizada') {
        porResponsable[responsableId].cierres.push(p);
      }
    }

    for (const [responsableIdTexto, grupos] of Object.entries(
      porResponsable
    )) {
      const responsableId = Number(responsableIdTexto);
      const telefonoResponsable =
        AGENTE_TELEFONO[responsableId];

      if (!telefonoResponsable) {
        console.error(
          'No hay teléfono configurado para resumen diario:',
          responsableId
        );
        continue;
      }

      let mensaje =
        `☀️ *Resumen diario de pendientes*\n\n` +
        `Hola ${grupos.nombre} 👋\n` +
        `Estos son tus casos pendientes para hoy:\n`;

      if (grupos.prospectos.length) {
        mensaje +=
          `\n📋 *Para contactar / coordinar demo (${grupos.prospectos.length})*\n`;

        for (const p of grupos.prospectos) {
          mensaje +=
            `• ${p.nombre_negocio || p.contacto || 'Sin nombre'}` +
            `${p.telefono ? ` — ${p.telefono}` : ''}\n`;

          if (p.nota_prospecto) {
            mensaje += `  📝 ${p.nota_prospecto}\n`;
          }
        }
      }

      if (grupos.demos.length) {
        mensaje +=
          `\n📅 *Demos coordinadas (${grupos.demos.length})*\n`;

        for (const p of grupos.demos) {
          const fecha = p.demo_fecha
            ? new Date(p.demo_fecha).toLocaleString(
                'es-AR',
                {
                  day: '2-digit',
                  month: '2-digit',
                  hour: '2-digit',
                  minute: '2-digit',
                  timeZone:
                    'America/Argentina/Buenos_Aires',
                }
              )
            : 'Sin fecha';

          mensaje +=
            `• ${p.nombre_negocio || p.contacto || 'Sin nombre'} — ${fecha}\n`;
        }
      }

      if (grupos.cierres.length) {
        mensaje +=
          `\n✅ *Demos realizadas pendientes de cierre (${grupos.cierres.length})*\n`;

        for (const p of grupos.cierres) {
          mensaje +=
            `• ${p.nombre_negocio || p.contacto || 'Sin nombre'}` +
            `${p.telefono ? ` — ${p.telefono}` : ''}\n`;
        }
      }

      try {
        const enviado = await enviarPorChatwoot(
          telefonoResponsable,
          mensaje.trim(),
          responsableId
        );

        if (enviado) {
          console.log(
            '✓ Resumen diario enviado a:',
            grupos.nombre,
            '| responsable:',
            responsableId
          );
        } else {
          console.error(
            'No se pudo enviar resumen diario a:',
            grupos.nombre
          );
        }
      } catch (err) {
        console.error(
          'Error enviando resumen diario a:',
          grupos.nombre,
          err.response?.data || err.message || err
        );
      }
    }
  } catch (err) {
    console.error(
      'Error generando resumen diario:',
      err.response?.data || err.message || err
    );
  }
}

start();