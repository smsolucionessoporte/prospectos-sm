'use strict';
// HTTP nativo de Node 18+, sin dependencias adicionales.
const TZ = 'America/Argentina/Buenos_Aires';
const {createHash} = require('node:crypto');
const MEET_GRUPAL = Object.freeze({
  am: { hora: '10:30', duracion: 30, url: 'https://meet.google.com/qzr-zuye-wku' },
  pm: { hora: '15:30', duracion: 30, url: 'https://meet.google.com/phy-ouvy-ayb' },
});
function parseLocal(value) {
  const match = String(value || '').match(/^(\d{4}-\d\d-\d\d)T(\d\d):(\d\d)$/);
  if (!match) throw new Error('Fecha y hora inválidas');
  const [, date, hour, minute] = match;
  if (new Date(`${date}T${hour}:${minute}:00Z`).toISOString().slice(0,10) !== date)
    throw new Error('Fecha inválida');
  if (Number(hour) > 23 || Number(minute) > 59) throw new Error('Horario inválido');
  return { date, time:`${hour}:${minute}`, utc: new Date(`${date}T${hour}:${minute}:00-03:00`) };
}
function checkSlot(date, slot, now=new Date()) {
  const def = MEET_GRUPAL[slot];
  if (!def) throw new Error('Turno inválido');
  const when = parseLocal(`${date}T${def.hora}`);
  const weekday = when.utc.getUTCDay(); // 10:30-03:00 no cambia día UTC
  if (weekday === 0 || weekday === 6) throw new Error('Las demostraciones son de lunes a viernes');
  if (when.utc.getTime() < now.getTime() + 15 * 60000) throw new Error('Elegí un turno futuro con al menos 15 minutos de anticipación');
  if (when.utc.getTime() > now.getTime() + 30 * 86400000) throw new Error('Solo se permiten reservas dentro de los próximos 30 días');
  return { ...when, slot, ...def };
}
function calendarioCompartidoId() {
  const id=String(process.env.GOOGLE_CALENDAR_ID||'').trim();
  if(!id||id.toLowerCase()==='primary') {
    throw new Error('Configurá GOOGLE_CALENDAR_ID con el ID real del calendario compartido SM SOLUCIONES (no primary)');
  }
  return id;
}
function correoValido(value){
  const email=String(value||'').trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)?email:null;
}
function calendarConfigured() {
  return Boolean(process.env.GOOGLE_CALENDAR_CLIENT_ID && process.env.GOOGLE_CALENDAR_CLIENT_SECRET && process.env.GOOGLE_CALENDAR_REFRESH_TOKEN);
}
async function googleAccessToken() {
  if (!calendarConfigured()) throw new Error('Google Calendar no autorizado: configurar OAuth y refresh token');
  const params = new URLSearchParams({
    grant_type:'refresh_token', client_id:process.env.GOOGLE_CALENDAR_CLIENT_ID,
    client_secret:process.env.GOOGLE_CALENDAR_CLIENT_SECRET,
    refresh_token:process.env.GOOGLE_CALENDAR_REFRESH_TOKEN,
  });
  const reply = await fetch('https://oauth2.googleapis.com/token',{method:'POST',body:params,signal:AbortSignal.timeout(12000)});
  if (!reply.ok) throw new Error(`No se pudo autorizar Google Calendar (HTTP ${reply.status})`);
  const data=await reply.json();
  if (!data.access_token) throw new Error('Google Calendar no devolvió un token');
  return data.access_token;
}
async function crearReunionMeet({title, localStart, description='', idempotencyKey=null, vendedorEmail=null}) {
  const start = parseLocal(localStart);
  if (start.utc.getTime() <= Date.now()) throw new Error('La reunión debe ser futura');
  const calendarId = encodeURIComponent(calendarioCompartidoId());
  const token = await googleAccessToken();
  const email=correoValido(vendedorEmail);
  const stableId=idempotencyKey ? 'sm'+createHash('sha256').update(String(idempotencyKey)).digest('hex').slice(0,40) : null;
  const event = {
    ...(stableId?{id:stableId}:{}),
    summary: title.slice(0,150), description: description.slice(0,1500),
    start:{dateTime:start.utc.toISOString(),timeZone:TZ},
    end:{dateTime:new Date(start.utc.getTime()+30*60000).toISOString(),timeZone:TZ},
    conferenceData:{createRequest:{requestId:require('crypto').randomUUID(),conferenceSolutionKey:{type:'hangoutsMeet'}}},
    reminders:{useDefault:false,overrides:[{method:'popup',minutes:15}]},
    guestsCanSeeOtherGuests:false,
    ...(email?{attendees:[{email}]}:{}),
  };
  const url = `https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events?conferenceDataVersion=1${email?'&sendUpdates=all':''}`;
  const existingUrl=stableId?`https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events/${stableId}`:null;
  const obtenerEventoExistente=async()=>{
    if(!existingUrl)return null;
    try{
      const result=await fetch(existingUrl,{headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(12000)});
      if(!result.ok)return null;
      const found=await result.json();
      // Jamás reutilizar un evento de un horario diferente.
      if(found.start?.dateTime && new Date(found.start.dateTime).getTime()!==start.utc.getTime())
        throw new Error('Existe un evento con el identificador de la demo pero tiene otra fecha');
      return found;
    }catch(err){if(err.message.includes('otra fecha'))throw err;return null;}
  };
  let data;
  try{
    const response=await fetch(url,{method:'POST',headers:{Authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify(event),signal:AbortSignal.timeout(20000)});
    if(response.ok)data=await response.json();
    else if(stableId && [409,429,500,502,503,504].includes(response.status)){
      data=await obtenerEventoExistente();
      if(!data)throw new Error(`Google Calendar rechazó crear la reunión (HTTP ${response.status})`);
    }else throw new Error(`Google Calendar rechazó crear la reunión (HTTP ${response.status})`);
  }catch(err){
    if(!data && stableId && (err.name==='AbortError'||err.name==='TimeoutError'||err instanceof TypeError))
      data=await obtenerEventoExistente();
    if(!data)throw err;
  }
  let joinUrl = data.hangoutLink || data.conferenceData?.entryPoints?.find(x=>x.entryPointType==='video')?.uri;
  // Calendar puede responder con conferencia pendiente: esperar el Meet antes de confirmar.
  if(!joinUrl && data.id){
    const eventUrl=`https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events/${encodeURIComponent(data.id)}`;
    for(const delay of [200,400,700,1100]){
      await new Promise(resolve=>setTimeout(resolve,delay));
      const details=await fetch(eventUrl,{headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(12000)});
      if(!details.ok)continue;
      const latest=await details.json();
      joinUrl=latest.hangoutLink || latest.conferenceData?.entryPoints?.find(x=>x.entryPointType==='video')?.uri;
      if(joinUrl){data={...latest,id:data.id};break;}
    }
  }
  // Un fallo al configurar la grabación NO invalida el evento ni su enlace de Meet.
  // Solo si Calendar no devolvió ningún enlace se elimina el evento incompleto.
  if (!joinUrl) {
    if(data.id){
      try {await fetch(`https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events/${encodeURIComponent(data.id)}`,{
        method:'DELETE',headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(12000)});
      }catch(cleanupError){console.error('[MEET] No se pudo eliminar evento sin enlace',data.id,cleanupError.message);}
    }
    throw new Error('Google Calendar creó el evento, pero no devolvió un enlace Meet');
  }
  // El rol COHOST no se concede invitando al vendedor: requiere spaces.members.create.
  // Se intentan por separado para no confundir un fallo de grabación con un fallo de coanfitrión.
  let recordingEnabled=false, recordingWarning=null, cohostEnabled=false, cohostWarning=null;
  let spaceName=null;
  try {
    const code = new URL(joinUrl).pathname.split('/').filter(Boolean).at(-1);
    if (!/^[a-z]{3}-[a-z]{4}-[a-z]{3}$/.test(code || ''))throw new Error('Código de Meet inválido');
    const r=await fetch(`https://meet.googleapis.com/v2/spaces/${code}`,{
      headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(12000)});
    if(!r.ok)throw new Error(`Meet no permitió consultar la sala (HTTP ${r.status})`);
    const space=await r.json();
    if(!/^spaces\/[A-Za-z0-9_-]+$/.test(space.name||''))throw new Error('ID de sala Meet inválido');
    spaceName=space.name;
  }catch(error){recordingWarning=`No se pudo consultar la sala para activar grabación: ${error.message}`;}

  if(spaceName){
    try{
      const patch=await fetch(`https://meet.googleapis.com/v2/${spaceName}?updateMask=config.artifactConfig.recordingConfig`,{
        method:'PATCH',headers:{Authorization:`Bearer ${token}`,'content-type':'application/json'},
        body:JSON.stringify({config:{artifactConfig:{recordingConfig:{autoRecordingGeneration:'ON'}}}}),signal:AbortSignal.timeout(12000)});
      if(!patch.ok)throw new Error(`No se pudo activar la grabación automática en Meet (HTTP ${patch.status})`);
      recordingEnabled=true;
    }catch(error){recordingWarning=error.message;}
  }

  if(!email){
    cohostWarning='No se encontró un correo válido del vendedor asignado; agregalo como coanfitrión manualmente.';
  }else if(!spaceName){
    cohostWarning='No se pudo configurar al vendedor como coanfitrión porque Google no devolvió la sala de Meet.';
  }else{
    try{
      // Requiere OAuth https://www.googleapis.com/auth/meetings.space.created.
      // No asumir éxito: Calendar puede crear el evento aunque Meet deniegue este rol.
      const memberUrl=`https://meet.googleapis.com/v2/${spaceName}/members`;
      const added=await fetch(memberUrl,{method:'POST',
        headers:{Authorization:`Bearer ${token}`,'content-type':'application/json'},
        body:JSON.stringify({email,role:'COHOST'}),signal:AbortSignal.timeout(12000)});
      if(added.ok){
        const member=await added.json();
        if(member.role!=='COHOST')throw new Error('Meet no confirmó el rol COHOST');
        cohostEnabled=true;
      }else if(added.status===409){
        // Idempotencia: un reintento puede encontrar al miembro ya creado.
        const found=await fetch(memberUrl,{headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(12000)});
        if(!found.ok)throw new Error(`No se pudo comprobar el coanfitrión existente (HTTP ${found.status})`);
        const result=await found.json();
        cohostEnabled=Array.isArray(result.members)&&result.members.some(m=>
          m.role==='COHOST'&&String(m.email||'').toLowerCase()===email);
        if(!cohostEnabled)throw new Error('Meet informa que el miembro existe, pero no confirmó el rol COHOST');
      }else throw new Error(`Meet rechazó configurar al coanfitrión (HTTP ${added.status})`);
    }catch(error){cohostWarning=`No se pudo dar el rol de coanfitrión a ${email}: ${error.message}`;}
  }
  if(recordingWarning)console.warn('[MEET] Evento creado sin grabación automática confirmada',data.id,recordingWarning);
  if(cohostWarning)console.warn('[MEET] Evento creado sin coanfitrión confirmado',data.id,cohostWarning);
  return {joinUrl,eventId:data.id,calendarUrl:data.htmlLink,recordingEnabled,recordingWarning,
    vendedorEmail:email,cohostEnabled,cohostWarning};
}
async function cancelarReunionMeet(eventId) {
  if(!eventId) return;
  const token=await googleAccessToken();
  // Eventos antiguos pueden estar en Marisol; los nuevos siempre van al calendario compartido.
  const primary=String(process.env.GOOGLE_CALENDAR_ID||'').trim();
  const calendars=[...(primary&&primary!=='primary'?[primary]:[]),'primary'];
  for(const id of calendars){
    const response=await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(id)}/events/${encodeURIComponent(eventId)}`,{
      method:'DELETE',headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(12000)});
    if(response.ok || response.status===410)return;
    if(response.status!==404)throw new Error(`No se pudo cancelar evento Meet: HTTP ${response.status}`);
  }
  console.warn('[MEET] No se encontró evento al cancelar (ningún calendario)',eventId);
}
module.exports={TZ,MEET_GRUPAL,parseLocal,checkSlot,calendarConfigured,crearReunionMeet,cancelarReunionMeet};
