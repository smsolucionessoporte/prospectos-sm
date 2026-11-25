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
    -- Las fichas eliminadas quedan archivadas y fuera de las métricas, sin destruir historial.
    ALTER TABLE prospectos ADD COLUMN IF NOT EXISTS eliminado_en TIMESTAMPTZ;
    ALTER TABLE prospectos ADD COLUMN IF NOT EXISTS eliminado_por INTEGER REFERENCES usuarios(id);
    -- Exclusión lógica persistente: cliente existente o ficha descartada no son leads nuevos.
    -- No se borran datos históricos de auditoría ni se altera Chatwoot.
    CREATE TABLE IF NOT EXISTS crm_chatwoot_exclusiones (
      chatwoot_conversation_id BIGINT PRIMARY KEY,
      motivo VARCHAR(40) NOT NULL,
      excluido_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_prospectos_no_eliminados ON prospectos(id) WHERE eliminado_en IS NULL;
    CREATE OR REPLACE VIEW crm_control_ventas_comercial AS
      SELECT cv.* FROM control_ventas cv WHERE NOT EXISTS (
        SELECT 1 FROM crm_chatwoot_exclusiones x
        WHERE x.chatwoot_conversation_id=cv.chatwoot_conversation_id
           OR EXISTS (SELECT 1 FROM prospectos_chatwoot_conversaciones v
             WHERE v.chatwoot_conversation_id=cv.chatwoot_conversation_id
               AND v.prospecto_id IN (SELECT p.id FROM prospectos p
                 WHERE p.chatwoot_conversation_id=x.chatwoot_conversation_id))
      ) AND NOT EXISTS (SELECT 1 FROM prospectos p
        WHERE p.eliminado_en IS NOT NULL AND
        (p.chatwoot_conversation_id=cv.chatwoot_conversation_id OR
          EXISTS (SELECT 1 FROM prospectos_chatwoot_conversaciones v
            WHERE v.prospecto_id=p.id AND v.chatwoot_conversation_id=cv.chatwoot_conversation_id)));
    CREATE OR REPLACE VIEW crm_prospectos_comerciales AS
      SELECT p.* FROM prospectos p WHERE p.eliminado_en IS NULL AND NOT EXISTS (
        SELECT 1 FROM crm_chatwoot_exclusiones x
        WHERE x.chatwoot_conversation_id=p.chatwoot_conversation_id
           OR EXISTS (SELECT 1 FROM prospectos_chatwoot_conversaciones v
               WHERE v.prospecto_id=p.id AND v.chatwoot_conversation_id=x.chatwoot_conversation_id)
      );
    -- Tombstones de conversaciones realmente eliminadas en Chatwoot.
    -- Nunca borrar control_ventas ni prospectos: preservamos auditoría histórica.
    CREATE TABLE IF NOT EXISTS crm_chatwoot_inexistentes (
      chatwoot_conversation_id BIGINT PRIMARY KEY,
      detectado_en TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      motivo VARCHAR(60) NOT NULL DEFAULT 'chatwoot_404'
    );
    ALTER TABLE crm_chatwoot_estado ADD COLUMN IF NOT EXISTS descartado_mensaje_id VARCHAR(60);
    ALTER TABLE crm_chatwoot_estado ADD COLUMN IF NOT EXISTS descartado_en TIMESTAMPTZ;
    ALTER TABLE crm_chatwoot_estado ADD COLUMN IF NOT EXISTS descartado_por INTEGER REFERENCES usuarios(id);
    ALTER TABLE crm_tareas ADD COLUMN IF NOT EXISTS recordatorio BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE crm_tareas ADD COLUMN IF NOT EXISTS etapa_origen VARCHAR(32);
    UPDATE crm_tareas t SET etapa_origen=p.estado FROM prospectos p
      WHERE t.prospecto_id=p.id AND t.etapa_origen IS NULL AND t.origen <> 'chatwoot';
    CREATE TABLE IF NOT EXISTS crm_seguimientos (
      id BIGSERIAL PRIMARY KEY,
      prospecto_id INTEGER NOT NULL REFERENCES prospectos(id) ON DELETE CASCADE,
      tarea_id BIGINT REFERENCES crm_tareas(id) ON DELETE SET NULL,
      usuario_id INTEGER NOT NULL REFERENCES usuarios(id),
      gestion_realizada TEXT NOT NULL,
      proxima_accion TEXT,
      vence_en TIMESTAMPTZ,
      prioridad VARCHAR(10) NOT NULL DEFAULT 'normal' CHECK (prioridad IN ('normal','alta')),
      recordatorio BOOLEAN NOT NULL DEFAULT FALSE,
      creado_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS crm_seguimientos_por_prospecto
      ON crm_seguimientos (prospecto_id, creado_en DESC);
    CREATE TABLE IF NOT EXISTS crm_recordatorios_tareas (
      id BIGSERIAL PRIMARY KEY,
      tarea_id BIGINT NOT NULL REFERENCES crm_tareas(id) ON DELETE CASCADE,
      vence_en TIMESTAMPTZ NOT NULL,
      estado VARCHAR(12) NOT NULL DEFAULT 'procesando',
      creado_en TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      enviado_en TIMESTAMPTZ,
      error TEXT,
      UNIQUE(tarea_id,vence_en)
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
