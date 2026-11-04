'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {actualizarResponsableReunionMeet}=require('./calendar');
const keys=['GOOGLE_CALENDAR_CLIENT_ID','GOOGLE_CALENDAR_CLIENT_SECRET','GOOGLE_CALENDAR_REFRESH_TOKEN','GOOGLE_CALENDAR_ID'];
function setup(){const env=Object.fromEntries(keys.map(k=>[k,process.env[k]]));for(const [i,k] of keys.entries())process.env[k]=['id','secret','refresh','shared@group.calendar.google.com'][i];return ()=>{for(const [k,v] of Object.entries(env)){if(v===undefined)delete process.env[k];else process.env[k]=v;}};}
function json(data,status=200){return new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json'}});}
test('cambiar responsable invita al nuevo, preserva otros invitados, asigna COHOST y quita coanfitrión antiguo',async()=>{
 const restore=setup(),oldFetch=globalThis.fetch,calls=[];
 globalThis.fetch=async(url,options={})=>{
  const u=String(url),method=options.method||'GET';calls.push({url:u,method,body:options.body});
  if(u.includes('oauth2.googleapis.com'))return json({access_token:'access'});
  if(method==='GET'&&u.includes('calendar/v3'))return json({id:'evt1',etag:'etag1',organizer:{email:'organizer@gmail.com'},attendees:[{email:'marisol@gmail.com'},{email:'prospecto@gmail.com'}]});
  if(method==='PATCH'&&u.includes('calendar/v3'))return json({id:'evt1'});
  if(u.endsWith('/spaces/abc-defg-hij'))return json({name:'spaces/spaceQ'});
  if(method==='GET'&&u.includes('/spaces/spaceQ/members'))return json({members:[{name:'spaces/spaceQ/members/old',email:'marisol@gmail.com',role:'COHOST'}]});
  if(method==='POST'&&u.includes('/spaces/spaceQ/members'))return json({name:'spaces/spaceQ/members/new',role:'COHOST',email:'rafael@gmail.com'});
  if(method==='DELETE'&&u.includes('/spaces/spaceQ/members/old'))return new Response(null,{status:204});
  return new Response('unexpected',{status:500});
 };
 try{
  const r=await actualizarResponsableReunionMeet({eventId:'evt1',joinUrl:'https://meet.google.com/abc-defg-hij',nuevoEmail:'RAFAEL@gmail.com',anteriorEmail:'marisol@gmail.com'});
  assert.equal(r.invitado,true);assert.equal(r.cohost,true);assert.deepEqual(r.avisos,[]);
  const patched=calls.find(x=>x.method==='PATCH'&&x.url.includes('calendar/v3'));
  assert.ok(patched);assert.match(patched.url,/sendUpdates=all/);
  assert.deepEqual(JSON.parse(patched.body).attendees,[{email:'prospecto@gmail.com'},{email:'rafael@gmail.com'}]);
  assert.equal(calls.filter(c=>c.method==='DELETE').length,1);
 }finally{globalThis.fetch=oldFetch;restore();}
});
test('si Meet no permite COHOST conserva invitación pero informa advertencia',async()=>{
 const restore=setup(),oldFetch=globalThis.fetch;
 globalThis.fetch=async(url,options={})=>{
  const u=String(url),method=options.method||'GET';
  if(u.includes('oauth2.googleapis.com'))return json({access_token:'access'});
  if(u.includes('calendar/v3')&&method==='GET')return json({id:'evt1',attendees:[]});
  if(u.includes('calendar/v3')&&method==='PATCH')return json({id:'evt1'});
  if(u.endsWith('/spaces/abc-defg-hij'))return json({name:'spaces/spaceQ'});
  if(method==='GET'&&u.includes('/spaces/spaceQ/members'))return json({members:[]});
  if(method==='POST'&&u.endsWith('/members'))return new Response('forbidden',{status:403});
  return new Response('unexpected',{status:500});
 };
 try{
  const r=await actualizarResponsableReunionMeet({eventId:'evt1',joinUrl:'https://meet.google.com/abc-defg-hij',nuevoEmail:'rafael@gmail.com'});
  assert.equal(r.invitado,true);assert.equal(r.cohost,false);assert.match(r.avisos.join(' '),/HTTP 403/);
 }finally{globalThis.fetch=oldFetch;restore();}
});
test('no inventa una invitación si la demo no tiene evento',async()=>{
 const r=await actualizarResponsableReunionMeet({eventId:null,nuevoEmail:'rafael@gmail.com'});
 assert.equal(r.invitado,false);assert.equal(r.cohost,false);
});
test('rechaza correo vacío y no hace llamadas externas',async()=>{
 await assert.rejects(actualizarResponsableReunionMeet({eventId:'evt1',nuevoEmail:''}),/correo válido/);
});
