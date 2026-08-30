'use strict';
const http=require('http'),{URL}=require('url'),fs=require('fs'),path=require('path');
const sessions=new Map(),rates=new Map();let nextEventId=1;
const SESSION_TTL_MS=Number(process.env.JOY_SESSION_TTL_MS||8*60*60*1000);
const EVENT_TTL_MS=Number(process.env.JOY_EVENT_TTL_MS||60*60*1000);
const MAX_EVENTS=Number(process.env.JOY_MAX_EVENTS||600);
const MAX_PAYLOAD=Number(process.env.JOY_MAX_PAYLOAD||50000);
const RATE_LIMIT=Number(process.env.JOY_RATE_LIMIT_PER_MIN||900),RATE_WINDOW_MS=60000;
const WEB_ORIGINS=String(process.env.JOY_WEB_ORIGINS||'*').split(',').map(x=>x.trim()).filter(Boolean);
function cors(req){
  const origin=String(req.headers.origin||'');
  if(WEB_ORIGINS.includes('*'))return {'access-control-allow-origin':'*'};
  if(origin&&WEB_ORIGINS.includes(origin))return {'access-control-allow-origin':origin,'vary':'Origin'};
  return {};
}
function headers(req,extra={}){return {'cache-control':'no-store','x-content-type-options':'nosniff','referrer-policy':'no-referrer',...cors(req),...extra}}
function text(req,res,status,body){res.writeHead(status,headers(req,{'content-type':'text/plain; charset=utf-8'}));res.end(body||'')}
function json(req,res,status,value,cache=false){res.writeHead(status,headers(req,{'content-type':'application/json; charset=utf-8','cache-control':cache?'public, max-age=300':'no-store'}));res.end(JSON.stringify(value))}
function ip(req){return String(req.headers['x-forwarded-for']||req.socket.remoteAddress||'unknown').split(',')[0].trim()}
function rateAllowed(req){const now=Date.now(),k=ip(req),r=rates.get(k)||{start:now,count:0};if(now-r.start>=RATE_WINDOW_MS){r.start=now;r.count=0}r.count++;rates.set(k,r);return r.count<=RATE_LIMIT}
function readForm(req){return new Promise((ok,bad)=>{let b='';req.on('data',c=>{b+=c;if(b.length>250000)req.destroy()});req.on('end',()=>ok(new URLSearchParams(b)));req.on('error',bad)})}
function getSession(code,proof){const s=sessions.get(code);if(!s||s.proof!==proof)return null;if(Date.now()-s.created>SESSION_TTL_MS){sessions.delete(code);return null}s.touched=Date.now();return s}
function compact(s){const cut=Date.now()-EVENT_TTL_MS;s.events=s.events.filter(e=>e.time>=cut);if(s.events.length>MAX_EVENTS)s.events.splice(0,s.events.length-MAX_EVENTS)}
function urls(raw,fallback){const v=String(raw||'').split(',').map(x=>x.trim()).filter(Boolean);return v.length?v:fallback}
function rtc(){const stun=urls(process.env.JOY_STUN_URLS,['stun:stun.l.google.com:19302']),iceServers=[{urls:stun.length===1?stun[0]:stun}],turn=urls(process.env.JOY_TURN_URLS,[]);if(turn.length){const x={urls:turn.length===1?turn[0]:turn};if(process.env.JOY_TURN_USERNAME)x.username=process.env.JOY_TURN_USERNAME;if(process.env.JOY_TURN_CREDENTIAL)x.credential=process.env.JOY_TURN_CREDENTIAL;iceServers.push(x)}return{iceServers,turnConfigured:turn.length>0}}
setInterval(()=>{const now=Date.now();for(const[k,s]of sessions){if(now-s.created>SESSION_TTL_MS)sessions.delete(k);else compact(s)}for(const[k,r]of rates)if(now-r.start>RATE_WINDOW_MS*3)rates.delete(k)},60000).unref();
const server=http.createServer(async(req,res)=>{
 try{
  if(req.method==='OPTIONS'){res.writeHead(204,headers(req,{'access-control-allow-methods':'GET,POST,OPTIONS','access-control-allow-headers':'content-type,cache-control','access-control-max-age':'86400'}));return res.end()}
  if(!rateAllowed(req))return text(req,res,429,'rate limit');
  const u=new URL(req.url,'http://localhost');
  if(req.method==='GET'&&u.pathname==='/health')return text(req,res,200,'JOY relay web-compatible v1.1 OK');
  if(req.method==='GET'&&u.pathname==='/v1/rtc-config')return json(req,res,200,rtc());
  if(req.method==='GET'&&u.pathname==='/v1/profiles'){const file=path.join(__dirname,'..','profile-catalog','profiles.json');res.writeHead(200,headers(req,{'content-type':'application/json; charset=utf-8','cache-control':'public, max-age=300'}));return res.end(fs.readFileSync(file,'utf8'))}
  if(req.method==='POST'&&u.pathname==='/v1/session/create'){const f=await readForm(req),code=f.get('code')||'',proof=f.get('proof')||'';if(!/^JOY-[A-Z2-9]{6}$/.test(code)||!/^[a-f0-9]{64}$/i.test(proof))return text(req,res,400,'invalid session');if(sessions.has(code))return text(req,res,409,'session already exists');sessions.set(code,{proof,events:[],created:Date.now(),touched:Date.now()});return text(req,res,201,'CREATED')}
  if(req.method==='POST'&&u.pathname==='/v1/session/join'){const f=await readForm(req),code=f.get('code')||'',proof=f.get('proof')||'';if(!getSession(code,proof))return text(req,res,404,'session not found');return text(req,res,200,'JOINED')}
  if(req.method==='POST'&&u.pathname==='/v1/session/close'){const f=await readForm(req),code=f.get('code')||'',proof=f.get('proof')||'';if(!getSession(code,proof))return text(req,res,404,'session not found');sessions.delete(code);return text(req,res,200,'CLOSED')}
  if(req.method==='POST'&&u.pathname==='/v1/event'){const f=await readForm(req),code=f.get('code')||'',proof=f.get('proof')||'',payload=f.get('payload')||'',s=getSession(code,proof);if(!s)return text(req,res,403,'invalid session');if(!payload||payload.length>MAX_PAYLOAD)return text(req,res,400,'invalid payload');compact(s);const ev={id:nextEventId++,payload,time:Date.now()};s.events.push(ev);compact(s);return text(req,res,201,String(ev.id))}
  if(req.method==='GET'&&u.pathname==='/v1/events'){const code=u.searchParams.get('code')||'',proof=u.searchParams.get('proof')||'',after=Number(u.searchParams.get('after')||0),s=getSession(code,proof);if(!s)return text(req,res,403,'invalid session');compact(s);return text(req,res,200,s.events.filter(e=>e.id>after).map(e=>`${e.id}\t${e.payload}`).join('\n'))}
  return text(req,res,404,'not found');
 }catch(e){console.error(e);return text(req,res,500,'server error')}
});
const port=Number(process.env.PORT||8787);server.listen(port,'0.0.0.0',()=>console.log(`JOY relay listening ${port}; web CORS=${WEB_ORIGINS.join(',')}`));
