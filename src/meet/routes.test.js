'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const express=require('express');
const {pool}=require('../db');
const {router}=require('./routes');
const {issue}=require('./booking-token');
const old={query:pool.query,connect:pool.connect};
const user={id:251,contacto:'Eleonora Schaab',telefono:'+5493777339918',estado:'prospecto',demo_responsable:null,creado_por:8,chatwoot_conversation_id:3053};
process.env.DEMO_BOOKING_SECRET='test-only-secret-for-signed-links-2026';
process.env.AUTOMATION_API_KEY='test-api-key';
const statements=[];
function reply(sql){
 statements.push(String(sql));
 if(String(sql).includes('SELECT * FROM prospectos'))return {rows:[{...user}],rowCount:1};
 if(String(sql).includes('SELECT id,estado FROM prospectos'))return {rows:[{id:251,estado:'prospecto'}]};
 if(String(sql).includes('SELECT cv.vendedor_id'))return {rows:[{vendedor_id:8}]};
 if(String(sql).includes('RETURNING *'))return {rows:[]};
 return {rows:[],rowCount:1};
}
let server,base;
test.before(async()=>{
 pool.query=async(sql)=>reply(sql);
 pool.connect=async()=>({query:async(sql)=>reply(sql),release:()=>{}});
 const app=express();app.use(express.json());app.use(express.urlencoded({extended:false}));app.use(router);
 server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));base=`http://127.0.0.1:${server.address().port}`;
});
test.after(async()=>{pool.query=old.query;pool.connect=old.connect;await new Promise(resolve=>server.close(resolve));});
test('no permite generar enlaces de reserva sin clave interna',async()=>{
 const response=await fetch(`${base}/api/demos/booking-link`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({chatwoot_conversation_id:3053})});
 assert.equal(response.status,401);
});
test('emite enlace personal protegido y permite elegir ambos horarios y otra opción',async()=>{
 const response=await fetch(`${base}/api/demos/booking-link`,{method:'POST',headers:{'content-type':'application/json','x-api-key':process.env.AUTOMATION_API_KEY},body:JSON.stringify({chatwoot_conversation_id:3053})});
 assert.equal(response.status,200);const data=await response.json();assert.match(data.url,/\/demo\/reservar\?token=/);
 const page=await fetch(`${base}/demo/reservar?token=${encodeURIComponent(issue(3053))}`);assert.equal(page.status,200);
 const body=await page.text();assert.match(body,/10:30/);assert.match(body,/15:30/);assert.match(body,/Necesito otro horario/);
});
test('reserva grupal cambia etapa, guarda Meet, historial y notificaciones individuales',async()=>{
 const now=new Date(),d=new Date(now.getTime()+5*86400000);
 // Elegir el próximo día hábil.
 while([0,6].includes(new Date(new Intl.DateTimeFormat('en-CA',{timeZone:'America/Argentina/Buenos_Aires',year:'numeric',month:'2-digit',day:'2-digit'}).format(d)+'T12:00:00Z').getUTCDay()))d.setUTCDate(d.getUTCDate()+1);
 const date=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Argentina/Buenos_Aires',year:'numeric',month:'2-digit',day:'2-digit'}).format(d);
 statements.length=0;
 const body=new URLSearchParams({token:issue(3053),tipo:'grupal',turno:`${date}|pm`});
 const response=await fetch(`${base}/demo/reservar`,{method:'POST',body,redirect:'manual'});assert.equal(response.status,200);
 assert.match((await response.text()),/quedó registrada/);
 assert.ok(statements.some(x=>x.includes("estado='demo_coordinada'")));
 assert.ok(statements.some(x=>x.includes('INSERT INTO historial_estados')));
 assert.ok(statements.some(x=>x.includes('INSERT INTO meet_avisos')));
});
