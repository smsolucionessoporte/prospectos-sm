'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {crearReunionMeet}=require('./calendar');
const ENV=['GOOGLE_CALENDAR_CLIENT_ID','GOOGLE_CALENDAR_CLIENT_SECRET','GOOGLE_CALENDAR_REFRESH_TOKEN'];
function configured(){for(const [i,k] of ENV.entries())process.env[k]=['id','secret','refresh'][i];}
function restore(original){for(const [k,v] of Object.entries(original)){if(v===undefined)delete process.env[k];else process.env[k]=v;}}
function futureDate(){const d=new Date(Date.now()+7*86400000);const local=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Argentina/Buenos_Aires',year:'numeric',month:'2-digit',day:'2-digit'}).format(d);return `${local}T11:00`;}
test('Meet personalizado: crea evento y exige que la grabación quede habilitada',async()=>{
 const original=globalThis.fetch, env=Object.fromEntries(ENV.map(k=>[k,process.env[k]]));configured();const calls=[];
 globalThis.fetch=(async(url,init)=>{
  const u=String(url);calls.push({url:u,method:init?.method});
  if(u.includes('oauth2.googleapis.com'))return new Response(JSON.stringify({access_token:'mock'}),{status:200});
  if(u.includes('calendar/v3')&&init?.method==='POST')return new Response(JSON.stringify({id:'evt456',hangoutLink:'https://meet.google.com/abc-defg-hij',htmlLink:'https://calendar.google.com/calendar/event?eid=xxx'}),{status:200});
  if(u.endsWith('spaces/abc-defg-hij'))return new Response(JSON.stringify({name:'spaces/spaceQ'}),{status:200});
  if(u.includes('spaces/spaceQ')&&init?.method==='PATCH')return new Response(JSON.stringify({name:'spaces/spaceQ'}),{status:200});
  return new Response('unexpected',{status:500});
 });
 try{const result=await crearReunionMeet({title:'Demo',localStart:futureDate()});assert.equal(result.joinUrl,'https://meet.google.com/abc-defg-hij');assert.equal(calls.filter(x=>x.method==='PATCH').length,1);}
 finally{globalThis.fetch=original;restore(env);}
});
test('si Google no permite grabación, intenta eliminar evento y no confirma',async()=>{
 const original=globalThis.fetch,env=Object.fromEntries(ENV.map(k=>[k,process.env[k]]));configured();let deleted=false;
 globalThis.fetch=(async(url,init)=>{
  const u=String(url);
  if(u.includes('oauth2.googleapis.com'))return new Response(JSON.stringify({access_token:'mock'}),{status:200});
  if(u.includes('calendar/v3')&&init?.method==='POST')return new Response(JSON.stringify({id:'evt456',hangoutLink:'https://meet.google.com/abc-defg-hij'}),{status:200});
  if(u.includes('spaces/abc-defg-hij'))return new Response(JSON.stringify({name:'spaces/spaceQ'}),{status:200});
  if(init?.method==='PATCH')return new Response('insufficient scopes',{status:403});
  if(init?.method==='DELETE'){deleted=true;return new Response(null,{status:204});}
  return new Response('unexpected',{status:500});
 });
 try{await assert.rejects(crearReunionMeet({title:'Demo',localStart:futureDate()}),/grabación automática/);assert.equal(deleted,true);}
 finally{globalThis.fetch=original;restore(env);}
});
test('si Calendar demora en generar el enlace, consulta el evento antes de confirmar',async()=>{
 const old=globalThis.fetch,env=Object.fromEntries(ENV.map(k=>[k,process.env[k]]));configured();let polls=0;
 globalThis.fetch=async(url,init)=>{
  const u=String(url);
  if(u.includes('oauth2.googleapis.com'))return new Response(JSON.stringify({access_token:'mock'}),{status:200});
  if(u.includes('calendar/v3')&&init?.method==='POST')return new Response(JSON.stringify({id:'evt456',conferenceData:{createRequest:{status:{statusCode:'pending'}}}}),{status:200});
  if(u.includes('calendar/v3')&&(!init?.method||init.method==='GET')){polls++;return new Response(JSON.stringify({id:'evt456',hangoutLink:'https://meet.google.com/abc-defg-hij'}),{status:200});}
  if(u.endsWith('spaces/abc-defg-hij'))return new Response(JSON.stringify({name:'spaces/spaceQ'}),{status:200});
  if(u.includes('spaces/spaceQ')&&init?.method==='PATCH')return new Response(JSON.stringify({name:'spaces/spaceQ'}),{status:200});
  return new Response('unexpected',{status:500});
 };
 try{const m=await crearReunionMeet({title:'Demo',localStart:futureDate()});assert.equal(m.eventId,'evt456');assert.equal(polls,1);}
 finally{globalThis.fetch=old;restore(env);}
});
