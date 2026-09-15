const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

const MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS usuarios (
  id SERIAL PRIMARY KEY,
  nombre VARCHAR(100) NOT NULL,
  email VARCHAR(150) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  rol VARCHAR(20) NOT NULL CHECK (rol IN ('administrativa', 'soporte', 'admin')),
  activo BOOLEAN DEFAULT true,
  creado_en TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS prospectos (
  id SERIAL PRIMARY KEY,
  nombre_negocio VARCHAR(200) NOT NULL,
  contacto VARCHAR(150) NOT NULL,
  telefono VARCHAR(50),
  email VARCHAR(150),
  estado VARCHAR(30) NOT NULL DEFAULT 'prospecto'
    CHECK (estado IN ('prospecto','demo_coordinada','demo_realizada','confirmado','perdido')),
  creado_por INTEGER REFERENCES usuarios(id),
  creado_en TIMESTAMP DEFAULT NOW(),
  actualizado_en TIMESTAMP DEFAULT NOW(),
  demo_fecha TIMESTAMP,
  demo_responsable INTEGER REFERENCES usuarios(id),
  rubro VARCHAR(100),
  rubro_otro VARCHAR(100),
  modulos TEXT[],
  sistema_actual VARCHAR(150),
  tiempo_sistema VARCHAR(50),
  problema_sistema TEXT,
  necesidades TEXT,
  cant_productos VARCHAR(50),
  cant_ventas VARCHAR(50),
  equipamiento TEXT[],
  equip_observaciones VARCHAR(255),
  objeciones JSONB,
  obj_detalle TEXT,
  nivel_interes VARCHAR(20) CHECK (nivel_interes IN ('alto','medio','bajo')),
  obs_generales TEXT,
  relevamiento_completado_por INTEGER REFERENCES usuarios(id),
  relevamiento_fecha TIMESTAMP,
  motivo_perdida TEXT,
  modulos_contratados TEXT[],
  condiciones_comerciales TEXT,
  fecha_confirmacion TIMESTAMP,
  notas_administrativas TEXT
  );

CREATE TABLE IF NOT EXISTS historial_estados (
  id SERIAL PRIMARY KEY,
  prospecto_id INTEGER REFERENCES prospectos(id) ON DELETE CASCADE,
  estado_anterior VARCHAR(30),
  estado_nuevo VARCHAR(30),
  usuario_id INTEGER REFERENCES usuarios(id),
  nota TEXT,
  fecha TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS session (
  sid VARCHAR NOT NULL COLLATE "default",
  sess JSON NOT NULL,
  expire TIMESTAMP(6) NOT NULL,
  CONSTRAINT session_pkey PRIMARY KEY (sid)
);

CREATE INDEX IF NOT EXISTS IDX_session_expire ON session (expire);
CREATE INDEX IF NOT EXISTS idx_prospectos_estado ON prospectos(estado);
CREATE INDEX IF NOT EXISTS idx_prospectos_creado_en ON prospectos(creado_en DESC);
ALTER TABLE prospectos ADD COLUMN IF NOT EXISTS nota_prospecto TEXT;
ALTER TABLE prospectos ADD COLUMN IF NOT EXISTS origen VARCHAR(100);
ALTER TABLE prospectos ADD COLUMN IF NOT EXISTS chatwoot_conversation_id BIGINT;
ALTER TABLE prospectos ADD COLUMN IF NOT EXISTS recordatorio_relevamiento_enviado BOOLEAN DEFAULT false;
CREATE INDEX IF NOT EXISTS idx_prospectos_chatwoot_conversation_id
  ON prospectos(chatwoot_conversation_id);

CREATE TABLE IF NOT EXISTS zoom_oauth_tokens (
  usuario_id INTEGER PRIMARY KEY REFERENCES usuarios(id) ON DELETE CASCADE,
  access_token TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  actualizado_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS control_ventas (
  id BIGSERIAL PRIMARY KEY,
  chatwoot_conversation_id BIGINT NOT NULL UNIQUE,

  origen VARCHAR(30),
  fecha_ingreso TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  respondio_cliente BOOLEAN NOT NULL DEFAULT false,
  fecha_primera_respuesta_cliente TIMESTAMPTZ,

  clasificacion VARCHAR(30),
  fecha_clasificacion TIMESTAMPTZ,

  derivado BOOLEAN NOT NULL DEFAULT false,
  fecha_derivacion TIMESTAMPTZ,

  vendedor_id INTEGER REFERENCES usuarios(id),
  vendedor_nombre VARCHAR(150),

  fecha_primera_respuesta_vendedor TIMESTAMPTZ,

  creado_en TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  actualizado_en TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CHECK (
    origen IS NULL OR
    origen IN ('meta', 'google', 'otro')
  ),

  CHECK (
    clasificacion IS NULL OR
    clasificacion IN (
      'valido',
      'consulta_erronea',
      'no_interesado'
    )
  )
);

CREATE INDEX IF NOT EXISTS idx_control_ventas_fecha_ingreso
  ON control_ventas(fecha_ingreso DESC);

CREATE INDEX IF NOT EXISTS idx_control_ventas_origen
  ON control_ventas(origen);

CREATE INDEX IF NOT EXISTS idx_control_ventas_vendedor
  ON control_ventas(vendedor_id);

CREATE INDEX IF NOT EXISTS idx_control_ventas_derivacion
  ON control_ventas(fecha_derivacion);
`;

async function runMigrations() {
  try {
    await pool.query(MIGRATION_SQL);
    console.log('✓ Migraciones ejecutadas');
  } catch (err) {
    console.error('Error en migraciones:', err.message);
    throw err;
  }
}

module.exports = { pool, runMigrations };
