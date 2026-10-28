const { pool } = require('../db');

// Esquema adicional idempotente: no migra ni elimina datos del CRM anterior.
async function iniciarCRM() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS crm_tareas (
      id BIGSERIAL PRIMARY KEY,
      prospecto_id INTEGER REFERENCES prospectos(id) ON DELETE CASCADE,
      chatwoot_conversation_id BIGINT,
      responsable_id INTEGER NOT NULL REFERENCES usuarios(id),
      creado_por INTEGER REFERENCES usuarios(id),
      tipo VARCHAR(24) NOT NULL DEFAULT 'seguimiento'
        CHECK (tipo IN ('llamada','seguimiento','demo','cierre','otro')),
      descripcion TEXT NOT NULL,
      vence_en TIMESTAMPTZ NOT NULL,
      prioridad VARCHAR(10) NOT NULL DEFAULT 'normal'
        CHECK (prioridad IN ('normal','alta')),
      estado VARCHAR(12) NOT NULL DEFAULT 'pendiente'
        CHECK (estado IN ('pendiente','completada','cancelada')),
      completada_en TIMESTAMPTZ,
      creada_en TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      actualizada_en TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK (prospecto_id IS NOT NULL OR chatwoot_conversation_id IS NOT NULL)
    );
    CREATE INDEX IF NOT EXISTS crm_tareas_responsable_vence
      ON crm_tareas (responsable_id, vence_en) WHERE estado = 'pendiente';
    CREATE INDEX IF NOT EXISTS crm_tareas_prospecto
      ON crm_tareas (prospecto_id);
    ALTER TABLE crm_tareas ADD COLUMN IF NOT EXISTS origen VARCHAR(20) NOT NULL DEFAULT 'manual';
    ALTER TABLE crm_tareas ADD COLUMN IF NOT EXISTS clave_automatica VARCHAR(90);
    CREATE UNIQUE INDEX IF NOT EXISTS crm_tareas_clave_automatica_uq
      ON crm_tareas (clave_automatica) WHERE clave_automatica IS NOT NULL;
    CREATE TABLE IF NOT EXISTS prospectos_chatwoot_conversaciones (
      chatwoot_conversation_id BIGINT PRIMARY KEY,
      prospecto_id INTEGER NOT NULL REFERENCES prospectos(id) ON DELETE CASCADE,
      creado_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_prospectos_chatwoot_vinculos_prospecto
      ON prospectos_chatwoot_conversaciones (prospecto_id);
    INSERT INTO prospectos_chatwoot_conversaciones (chatwoot_conversation_id,prospecto_id)
    SELECT chatwoot_conversation_id,id FROM prospectos
    WHERE chatwoot_conversation_id IS NOT NULL
    ON CONFLICT (chatwoot_conversation_id) DO NOTHING;
    CREATE TABLE IF NOT EXISTS crm_chatwoot_estado (
      chatwoot_conversation_id BIGINT PRIMARY KEY,
      inbox_id INTEGER,
      responsable_id INTEGER REFERENCES usuarios(id),
      nombre_contacto TEXT,
      estado_chatwoot VARCHAR(30),
      ultima_entrada TIMESTAMPTZ,
      ultima_salida_humana TIMESTAMPTZ,
      ultimo_mensaje_id VARCHAR(60),
      requiere_respuesta BOOLEAN NOT NULL DEFAULT FALSE,
      ultima_revision TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS crm_chatwoot_estado_prioridades
      ON crm_chatwoot_estado (responsable_id, ultima_entrada DESC)
      WHERE requiere_respuesta=TRUE;
    CREATE TABLE IF NOT EXISTS crm_avisos (
      id BIGSERIAL PRIMARY KEY,
      fecha DATE NOT NULL,
      tipo VARCHAR(30) NOT NULL,
      usuario_id INTEGER NOT NULL REFERENCES usuarios(id),
      estado VARCHAR(12) NOT NULL DEFAULT 'procesando',
      creado_en TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      enviado_en TIMESTAMPTZ,
      error TEXT,
      UNIQUE(fecha, tipo, usuario_id)
    );
  `);
  console.log('✓ Estructura de SM Comercial preparada');
}

module.exports = { iniciarCRM };
