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

// ─── RESUMEN DIARIO AL GRUPO ───────────────────────────────────────────────
function iniciarResumenDiario() {
  cron.schedule('0 9 * * 1-5', () => {
    enviarResumenDiario();
  }, { timezone: 'America/Argentina/Buenos_Aires' });
}

async function enviarResumenDiario() {
  try {
    

    const pendientesDemo = await pool.query(`
      SELECT p.*, u.nombre as u_nombre
      FROM prospectos p
      LEFT JOIN usuarios u ON p.creado_por = u.id
      WHERE p.estado = 'prospecto'
    `);
    const demosCoordinadas = await pool.query(`
      SELECT p.*, u.nombre as u_nombre
      FROM prospectos p
      LEFT JOIN usuarios u ON p.demo_responsable = u.id
      WHERE p.estado = 'demo_coordinada'
    `);
    const pendientesConfirmar = await pool.query(`
      SELECT p.*, u.nombre as u_nombre
      FROM prospectos p
      LEFT JOIN usuarios u ON p.demo_responsable = u.id
      WHERE p.estado = 'demo_realizada'
    `);

    if (!pendientesDemo.rows.length && !demosCoordinadas.rows.length && !pendientesConfirmar.rows.length) return;

    let mensaje = `☀️ Resumen diario de casos pendientes:\n`;

    if (pendientesDemo.rows.length) {
      mensaje += `\n📋 *Pendientes de coordinar demo (${pendientesDemo.rows.length}):*\n`;
      pendientesDemo.rows.forEach(p => {
        mensaje += `• ${p.nombre_negocio || p.contacto || 'Sin nombre'} — ${p.telefono} (cargó: ${p.u_nombre || '—'})\n`;
        if (p.notas) mensaje += `   📝 ${p.notas}\n`;
      });
    }
    
    if (demosCoordinadas.rows.length) {
      mensaje += `\n📅 *Demos coordinadas (${demosCoordinadas.rows.length}):*\n`;
      demosCoordinadas.rows.forEach(p => {
        const fecha = new Date(p.demo_fecha).toLocaleString('es-AR', {day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'});
        mensaje += `• ${p.nombre_negocio || p.contacto || 'Sin nombre'} — ${p.telefono} — ${fecha} (${p.u_nombre || '—'})\n`;
      });
    }
      if (pendientesConfirmar.rows.length) {
        mensaje += `\n✅ *Demos realizadas, a definir (${pendientesConfirmar.rows.length}):*\n`;
        const porResponsable = {};
        pendientesConfirmar.rows.forEach(p => {
          const resp = responsableCierre(p) || '—';
          if (!porResponsable[resp]) porResponsable[resp] = [];
          porResponsable[resp].push(p);
        });
        Object.entries(porResponsable).forEach(([resp, items]) => {
          mensaje += `\n Cierre: ${resp}_\n`;
          items.forEach(p => mensaje += `• ${p.nombre_negocio || p.contacto || 'Sin nombre'} — ${p.telefono} (${p.u_nombre || '—'})\n`);
        });
      }

      await enviarAvisoInterno(mensaje);
  } catch (err) {
    console.error('Error en resumen diario:', err);
  }
}

start();