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
