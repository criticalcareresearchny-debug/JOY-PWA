'use strict';
const {spawn}=require('child_process'),crypto=require('crypto');
const port=18787,base=`http://127.0.0.1:${port}`;
const child=spawn(process.execPath,['server.js'],{cwd:__dirname,env:{...process.env,PORT:String(port),JOY_WEB_ORIGINS:'https://example.com'},stdio:['ignore','pipe','pipe']});
const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function req(path,opt={}){const r=await fetch(base+path,opt),t=await r.text();if(!r.ok)throw new Error(`${r.status} ${t}`);return t}
async function form(path,data){return req(path,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded','origin':'https://example.com'},body:new URLSearchParams(data)})}
(async()=>{try{
 await wait(450);const h=await req('/health',{headers:{origin:'https://example.com'}});if(!h.includes('JOY'))throw Error('health');
 const code='JOY-ABC234',secret=crypto.randomBytes(32).toString('base64url'),proof=crypto.createHash('sha256').update(secret).digest('hex');
 await form('/v1/session/create',{code,proof});await form('/v1/session/join',{code,proof});await form('/v1/event',{code,proof,payload:'iv.ciphertext'});
 const ev=await req(`/v1/events?code=${code}&proof=${proof}&after=0`,{headers:{origin:'https://example.com'}});if(!ev.includes('iv.ciphertext'))throw Error('event');
 const p=JSON.parse(await req('/v1/profiles'));if(p.schemaVersion!==3)throw Error('profiles');
 await form('/v1/session/close',{code,proof});console.log('JOY relay self-test PASS');
 }catch(e){console.error(e);process.exitCode=1}finally{child.kill('SIGTERM')}})();
