require('dotenv').config();
const express = require('express');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const { pool, runMigrations } = require('./db');
const authRoutes = require('./routes/auth');
const panelRoutes = require('./routes/panel');
const prospectosRoutes = require('./routes/prospectos');

const app = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3000;

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static('public'));

app.use(session({
  store: new pgSession({ pool, tableName: 'session' }),
  secret: process.env.SESSION_SECRET || 'sm-secret-local',
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
    `, [process.env.ADMIN_EMAIL || 'admin@smsoluciones.com', hash]);
    console.log('✓ Usuario admin creado:', process.env.ADMIN_EMAIL || 'admin@smsoluciones.com');
    console.log('  Contraseña:', process.env.ADMIN_PASSWORD || 'admin123');
    console.log('  ⚠️  Cambiá la contraseña después del primer login!');
  }
}

start();
