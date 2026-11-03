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
async function crearReunionMeet({title, localStart, description='', idempotencyKey=null}) {
  const start = parseLocal(localStart);
  if (start.utc.getTime() <= Date.now()) throw new Error('La reunión debe ser futura');
  const token = await googleAccessToken();
  const calendarId = encodeURIComponent(process.env.GOOGLE_CALENDAR_ID || 'primary');
  const stableId=idempotencyKey ? 'sm'+createHash('sha256').update(String(idempotencyKey)).digest('hex').slice(0,40) : null;
  const event = {
    ...(stableId?{id:stableId}:{}),
    summary: title.slice(0,150), description: description.slice(0,1500),
    start:{dateTime:start.utc.toISOString(),timeZone:TZ},
    end:{dateTime:new Date(start.utc.getTime()+30*60000).toISOString(),timeZone:TZ},
    conferenceData:{createRequest:{requestId:require('crypto').randomUUID(),conferenceSolutionKey:{type:'hangoutsMeet'}}},
    reminders:{useDefault:false,overrides:[{method:'popup',minutes:15}]},
    guestsCanSeeOtherGuests:false,
  };
  const url = `https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events?conferenceDataVersion=1`;
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
  let recordingEnabled=false, recordingWarning=null;
  try {
    const code = new URL(joinUrl).pathname.split('/').filter(Boolean).at(-1);
    if (!/^[a-z]{3}-[a-z]{4}-[a-z]{3}$/.test(code || '')) throw new Error('Código Meet inválido para configurar grabación');
    const getSpace=await fetch(`https://meet.googleapis.com/v2/spaces/${code}`,{headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(12000)});
    if (!getSpace.ok) throw new Error(`No se pudo consultar la configuración de Meet (HTTP ${getSpace.status})`);
    const space=await getSpace.json();
    if (!/^spaces\/[A-Za-z0-9_-]+$/.test(space.name || '')) throw new Error('Respuesta de Google Meet inválida');
    const patch=await fetch(`https://meet.googleapis.com/v2/${space.name}?updateMask=config.artifactConfig.recordingConfig`,{
      method:'PATCH',headers:{Authorization:`Bearer ${token}`,'content-type':'application/json'},
      body:JSON.stringify({config:{artifactConfig:{recordingConfig:{autoRecordingGeneration:'ON'}}}}),signal:AbortSignal.timeout(12000)});
    if(!patch.ok) throw new Error(`No se pudo activar la grabación automática en Meet (HTTP ${patch.status})`);
    recordingEnabled=true;
  }catch(error){
    recordingWarning=error.message;
    console.warn('[MEET] Reunión creada con enlace, pero sin grabación automática confirmada:',data.id,recordingWarning);
  }
  return {joinUrl,eventId:data.id,calendarUrl:data.htmlLink,recordingEnabled,recordingWarning};
}
async function cancelarReunionMeet(eventId) {
  if(!eventId) return;
  const token=await googleAccessToken();
  const calendarId=encodeURIComponent(process.env.GOOGLE_CALENDAR_ID||'primary');
  const response=await fetch(`https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events/${encodeURIComponent(eventId)}`,{
    method:'DELETE',headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(12000)});
  if(!response.ok && response.status!==404 && response.status!==410)throw new Error(`No se pudo cancelar evento Meet: HTTP ${response.status}`);
}
module.exports={TZ,MEET_GRUPAL,parseLocal,checkSlot,calendarConfigured,crearReunionMeet,cancelarReunionMeet};
