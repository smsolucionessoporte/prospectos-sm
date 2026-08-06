-- Migración inicial: Sistema de prospectos SM / SM Soluciones
-- Ejecutar una vez al iniciar el proyecto en Railway

-- Tabla de usuarios del sistema (Administrativa y Soporte)
CREATE TABLE IF NOT EXISTS usuarios (
  id SERIAL PRIMARY KEY,
  nombre VARCHAR(100) NOT NULL,
  email VARCHAR(150) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  rol VARCHAR(20) NOT NULL CHECK (rol IN ('administrativa', 'soporte', 'admin')),
  activo BOOLEAN DEFAULT true,
  creado_en TIMESTAMP DEFAULT NOW()
);

-- Tabla principal de prospectos
CREATE TABLE IF NOT EXISTS prospectos (
  id SERIAL PRIMARY KEY,

  -- Datos básicos (carga Administrativa)
  nombre_negocio VARCHAR(200) NOT NULL,
  contacto VARCHAR(150) NOT NULL,
  telefono VARCHAR(50),
  email VARCHAR(150),
  
  -- Estado del proceso
  estado VARCHAR(30) NOT NULL DEFAULT 'prospecto'
    CHECK (estado IN ('prospecto','demo_coordinada','demo_realizada','propuesta_enviada','confirmado','perdido')),
  
  -- Auditoría
  creado_por INTEGER REFERENCES usuarios(id),
  creado_en TIMESTAMP DEFAULT NOW(),
  actualizado_en TIMESTAMP DEFAULT NOW(),
  
  -- Demo coordinada (Soporte)
  demo_fecha TIMESTAMP,
  demo_responsable INTEGER REFERENCES usuarios(id),
  
  -- Relevamiento post-demo (Soporte) - datos del formulario
  rubro VARCHAR(100),
  rubro_otro VARCHAR(100),
  modulos TEXT[], -- array de módulos seleccionados
  sistema_actual VARCHAR(150),
  tiempo_sistema VARCHAR(50),
  problema_sistema TEXT,
  necesidades TEXT,
  cant_productos VARCHAR(50),
  cant_ventas VARCHAR(50),
  equipamiento TEXT[], -- array de equipos
  equip_observaciones VARCHAR(255),
  objeciones JSONB, -- {precio: true, resistencia: false, ...}
  obj_detalle TEXT,
  nivel_interes VARCHAR(20) CHECK (nivel_interes IN ('alto','medio','bajo')),
  obs_generales TEXT,
  relevamiento_completado_por INTEGER REFERENCES usuarios(id),
  relevamiento_fecha TIMESTAMP,

  -- Cierre (Administrativa)
  motivo_perdida TEXT,
  modulos_contratados TEXT[],
  condiciones_comerciales TEXT,
  fecha_confirmacion TIMESTAMP,
  notas_administrativas TEXT
);

-- Historial de cambios de estado
CREATE TABLE IF NOT EXISTS historial_estados (
  id SERIAL PRIMARY KEY,
  prospecto_id INTEGER REFERENCES prospectos(id) ON DELETE CASCADE,
  estado_anterior VARCHAR(30),
  estado_nuevo VARCHAR(30),
  usuario_id INTEGER REFERENCES usuarios(id),
  nota TEXT,
  fecha TIMESTAMP DEFAULT NOW()
);

-- Tabla de sesiones para express-session
CREATE TABLE IF NOT EXISTS session (
  sid VARCHAR NOT NULL COLLATE "default",
  sess JSON NOT NULL,
  expire TIMESTAMP(6) NOT NULL,
  CONSTRAINT session_pkey PRIMARY KEY (sid)
);
CREATE INDEX IF NOT EXISTS IDX_session_expire ON session (expire);

-- Índices útiles
CREATE INDEX IF NOT EXISTS idx_prospectos_estado ON prospectos(estado);
CREATE INDEX IF NOT EXISTS idx_prospectos_creado_en ON prospectos(creado_en DESC);
