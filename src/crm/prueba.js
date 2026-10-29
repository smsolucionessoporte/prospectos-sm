'use strict';
// Estado Prueba: 7 días corridos desde la activación efectiva.
// Registro transaccional + cola duradera de notificaciones para no repetir el alta.
const { pool } = require('../db');
const { enviarPorChatwoot } = require('../zoomChatwoot');
const { AGENTE_TELEFONO, telefonoVendedor } = require('../zoomAgentes');
const ZONA = 'America/Argentina/Buenos_Aires';
const formatear = d => new Intl.DateTimeFormat('es-AR', { timeZone: ZONA, day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit' }).format(new Date(d));
const estadoPrueba = (estado, vence, ahora = Date.now()) => estado === 'prueba'
  ? (!vence ? 'Prueba sin vencimiento' : new Date(vence).getTime() <= ahora ? 'Prueba vencida' : 'Prueba vigente')
  : null;

async function iniciarPruebaSchema() {
  // Solo modifica la constraint en la primera instalación: evita bloquear tablas
  // en cada reinicio de Railway.
  await pool.query(`
    DO $$
    DECLARE definicion TEXT;
    BEGIN
      SELECT pg_get_constraintdef(oid) INTO definicion FROM pg_constraint
      WHERE conrelid='prospectos'::regclass AND conname='prospectos_estado_check';
      IF definicion IS NULL OR POSITION('prueba' IN definicion) = 0 THEN
        ALTER TABLE prospectos DROP CONSTRAINT IF EXISTS prospectos_estado_check;
        ALTER TABLE prospectos ADD CONSTRAINT prospectos_estado_check
          CHECK (estado IN ('prospecto','sin_respuesta','demo_coordinada','demo_realizada','prueba','confirmado','perdido'));
      END IF;
    END $$;
    ALTER TABLE prospectos ADD COLUMN IF NOT EXISTS prueba_inicio TIMESTAMPTZ;
    ALTER TABLE prospectos ADD COLUMN IF NOT EXISTS prueba_vence TIMESTAMPTZ;
    CREATE TABLE IF NOT EXISTS crm_prueba_avisos (
      id BIGSERIAL PRIMARY KEY,
      prospecto_id INTEGER NOT NULL REFERENCES prospectos(id) ON DELETE CASCADE,
      tipo VARCHAR(40) NOT NULL CHECK(tipo IN ('activacion_cliente','activacion_responsable','vencimiento_cliente','vencimiento_responsable')),
      estado VARCHAR(16) NOT NULL DEFAULT 'pendiente'
        CHECK(estado IN ('pendiente','enviando','enviado','omitido','error')),
      disponible_en TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      intentos INTEGER NOT NULL DEFAULT 0,
      reclamado_en TIMESTAMPTZ,
      enviado_en TIMESTAMPTZ,
      error TEXT,
      UNIQUE(prospecto_id,tipo)
    );
    CREATE INDEX IF NOT EXISTS crm_prueba_avisos_pendientes ON crm_prueba_avisos(disponible_en)
      WHERE estado IN ('pendiente','error','enviando');
  `);
}

async function activarPrueba({ prospectoId, usuarioId, responsableId, nota = '' }) {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const { rows } = await db.query('SELECT id,estado,prueba_inicio FROM prospectos WHERE id=$1 FOR UPDATE',[prospectoId]);
    if (!rows.length) { await db.query('ROLLBACK'); return {ok:false,motivo:'No existe el prospecto'}; }
    if (rows[0].estado !== 'demo_realizada' || rows[0].prueba_inicio) {
      await db.query('ROLLBACK');
      return {ok:false,motivo:'La prueba solo puede activarse una vez después de la demo realizada'};
    }
    if (!Number.isSafeInteger(responsableId) || responsableId <= 0) {
      await db.query('ROLLBACK');return {ok:false,motivo:'Falta definir el responsable del prospecto'};
    }
    const actualizada = await db.query(`UPDATE prospectos SET estado='prueba', prueba_inicio=NOW(),
      prueba_vence=NOW() + INTERVAL '7 days', actualizado_en=NOW()
      WHERE id=$1 RETURNING prueba_inicio,prueba_vence`,[prospectoId]);
    const {prueba_vence: vence} = actualizada.rows[0];
    await db.query(`INSERT INTO historial_estados (prospecto_id,estado_anterior,estado_nuevo,usuario_id,nota)
      VALUES ($1,'demo_realizada','prueba',$2,$3)`,[prospectoId,usuarioId,
        `Se activó la prueba por 7 días. Vence ${formatear(vence)}.${nota ? ' '+String(nota).slice(0,400):''}`]);
    await db.query(`UPDATE crm_tareas SET estado='cancelada',actualizada_en=NOW() WHERE prospecto_id=$1 AND estado='pendiente' AND origen <> 'chatwoot'`,[prospectoId]);
    // Una tarea para el responsable. Desaparece si se confirma o pierde.
    await db.query(`INSERT INTO crm_tareas(prospecto_id,responsable_id,creado_por,tipo,descripcion,
      vence_en,prioridad,origen,clave_automatica,etapa_origen,recordatorio)
      VALUES($1,$2,$3,'seguimiento','Revisar vencimiento de la prueba y definir contratación',$4,
      'alta','prueba',$5,'prueba',TRUE) ON CONFLICT (clave_automatica) WHERE clave_automatica IS NOT NULL DO NOTHING`,
      [prospectoId,responsableId,usuarioId,vence,`prueba:${prospectoId}`]);
    await db.query(`INSERT INTO crm_prueba_avisos(prospecto_id,tipo,disponible_en)
      VALUES($1,'activacion_cliente',NOW()),($1,'activacion_responsable',NOW()),
      ($1,'vencimiento_cliente',$2),($1,'vencimiento_responsable',$2) ON CONFLICT (prospecto_id,tipo) DO NOTHING`,[prospectoId,vence]);
    await db.query('COMMIT');
    return {ok:true,vence};
  } catch(error) { await db.query('ROLLBACK').catch(()=>{});throw error; }
  finally { db.release(); }
}

function construirMensaje(tipo,p) {
  const nombre = p.contacto || p.nombre_negocio || 'cliente';
  const vence = formatear(p.prueba_vence);
  if(tipo === 'activacion_cliente') return `*SM Soluciones · Sistema de prueba*\n\n¡Hola, ${nombre}! 👋\n\nTe confirmamos que se activó tu período de prueba de nuestro sistema.\n📆 *Duración:* 7 días corridos\n⏰ *Finaliza:* ${vence} (hora de Buenos Aires).\n\nDurante este período podés evaluar el funcionamiento. Si necesitás ayuda, contactá a Soporte: +54 9 11 2287-3021.\n\nAntes de finalizar el plazo, tu asesor comercial podrá ayudarte a definir cómo continuar.`;
  const nombreProspecto = p.nombre_negocio || p.contacto || `Prospecto #${p.id}`;
  const link = `${String(process.env.APP_URL || process.env.PUBLIC_BASE_URL || 'https://prospectos-sm-production.up.railway.app').replace(/\/$/,'')}/prospectos/${p.id}`;
  if(tipo === 'vencimiento_cliente') return `*SM Soluciones · Finalización de prueba*\n\n¡Hola, ${nombre}! 👋\n\nHoy se cumple el plazo de 7 días de tu prueba comercial.\n📅 Vencimiento: ${vence}.\n\nTu asesor comercial puede ayudarte a continuar utilizando el sistema o resolver cualquier consulta sobre los planes disponibles.`;
  if(tipo === 'vencimiento_responsable') return `⏰ *Prueba vencida · SM Comercial*\n\n👤 ${nombreProspecto}\n📅 Venció: ${vence}\n📞 ${p.telefono || 'Sin teléfono'}\n\nContactá al prospecto para confirmar, registrar pérdida o dejar seguimiento. La ficha NO se cierra automáticamente.\n👉 ${link}`;
  return `🧪 *Sistema de prueba activado*\n\n👤 ${nombreProspecto}\n📞 ${p.telefono || 'Sin teléfono'}\n📆 Inicio: ${formatear(p.prueba_inicio)}\n⏰ Vencimiento: ${vence} (7 días)\n\nRealizá el seguimiento y contactá al cliente antes del vencimiento.\n👉 ${link}`;
}

let procesando = false;
async function procesarAvisosPrueba({ limite = 15 } = {}) {
  if(procesando) return {procesados:0,ocupado:true};
  procesando=true;
  let procesados=0;
  try {
    // Claim atómico para evitar que dos réplicas envíen a la vez.
    const {rows: avisos}=await pool.query(`WITH pendientes AS (
      SELECT id FROM crm_prueba_avisos WHERE disponible_en<=NOW() AND intentos<10 AND
      (tipo NOT LIKE 'vencimiento_%' OR (
        EXTRACT(ISODOW FROM NOW() AT TIME ZONE 'America/Argentina/Buenos_Aires') BETWEEN 1 AND 5
        AND (NOW() AT TIME ZONE 'America/Argentina/Buenos_Aires')::time >= TIME '09:00'
        AND (NOW() AT TIME ZONE 'America/Argentina/Buenos_Aires')::time < TIME '17:00'
      )) AND
      (estado='pendiente' OR (estado='error' AND reclamado_en<NOW()-INTERVAL '10 minutes')
       OR (estado='enviando' AND reclamado_en<NOW()-INTERVAL '15 minutes'))
      ORDER BY disponible_en,id LIMIT $1 FOR UPDATE SKIP LOCKED)
      UPDATE crm_prueba_avisos a SET estado='enviando', reclamado_en=NOW(),
      intentos=a.intentos+1 FROM pendientes WHERE a.id=pendientes.id
      RETURNING a.id,a.prospecto_id,a.tipo`,[Math.min(Math.max(Number(limite)||15,1),50)]);
    for(const a of avisos) {
      try {
        const {rows}=await pool.query(`SELECT p.*,cv.vendedor_id FROM prospectos p
          LEFT JOIN LATERAL (SELECT vendedor_id FROM control_ventas
          WHERE chatwoot_conversation_id=p.chatwoot_conversation_id OR chatwoot_conversation_id IN
            (SELECT chatwoot_conversation_id FROM prospectos_chatwoot_conversaciones WHERE prospecto_id=p.id)
          ORDER BY actualizado_en DESC LIMIT 1) cv ON TRUE WHERE p.id=$1`,[a.prospecto_id]);
        const p=rows[0];
        if(!p || p.estado!=='prueba') {
          await pool.query("UPDATE crm_prueba_avisos SET estado='omitido',error='Etapa ya no vigente' WHERE id=$1",[a.id]);continue;
        }
        const mensaje=construirMensaje(a.tipo,p);
        let telefono,usuario;
        const asignado = Number(p.origen === 'prospecto-interno'
          ? (p.demo_responsable || p.creado_por)
          : (p.vendedor_id || p.demo_responsable || p.creado_por));
        if(a.tipo==='activacion_cliente' || a.tipo==='vencimiento_cliente') {telefono=String(p.telefono||'').trim();usuario=asignado;}
        else {
          usuario=asignado;
          telefono=telefonoVendedor(usuario) || AGENTE_TELEFONO[usuario];
        }
        if(!telefono || !usuario) throw Error('No se encontró teléfono o responsable');
        const ok=await enviarPorChatwoot(telefono,mensaje,usuario);
        if(!ok) throw Error('Chatwoot no confirmó el envío');
        await pool.query("UPDATE crm_prueba_avisos SET estado='enviado',enviado_en=NOW(),error=NULL WHERE id=$1",[a.id]);
        procesados++;
      }catch(error){
        console.error('[PRUEBA] Aviso sin enviar',a.id,a.tipo,error.message);
        await pool.query("UPDATE crm_prueba_avisos SET estado='error',error=$2 WHERE id=$1",[a.id,String(error.message).slice(0,500)]);
      }
    }
  } finally {procesando=false;}
  return {procesados};
}
function iniciarAvisosPrueba() {
  setTimeout(() => procesarAvisosPrueba().catch(e=>console.error('[PRUEBA] Avisos iniciales:',e)),5000);
  const cron=require('node-cron');
  cron.schedule('*/2 * * * *',()=>procesarAvisosPrueba().catch(e=>console.error('[PRUEBA] Procesamiento:',e)),{timezone:ZONA});
}
module.exports={iniciarPruebaSchema,activarPrueba,procesarAvisosPrueba,iniciarAvisosPrueba,construirMensaje,estadoPrueba};
