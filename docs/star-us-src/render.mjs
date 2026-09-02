import {spawn} from 'node:child_process';
import fs from 'node:fs';
const CH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const port=9333;
const chrome=spawn(CH,[`--remote-debugging-port=${port}`,'--headless=new','--disable-gpu','--hide-scrollbars','--no-first-run','--no-default-browser-check','--user-data-dir=/tmp/starus/prof2','--window-size=1200,640','about:blank'],{stdio:'ignore'});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let targets;
for(let i=0;i<60;i++){try{targets=await (await fetch(`http://127.0.0.1:${port}/json`)).json();if(targets.length)break;}catch{}await sleep(250);}
const page=targets.find(t=>t.type==='page');
const ws=new WebSocket(page.webSocketDebuggerUrl);
await new Promise(r=>ws.onopen=r);
let id=0;const pending=new Map();const events=[];
ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id&&pending.has(m.id)){pending.get(m.id)(m);pending.delete(m.id)}else if(m.method)events.push(m)};
const send=(method,params={})=>new Promise(res=>{const i=++id;pending.set(i,res);ws.send(JSON.stringify({id:i,method,params}))});
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride',{width:1200,height:640,deviceScaleFactor:2,mobile:false});
const FPS=15,DUR=4.6;const n=Math.round(DUR*FPS);
fs.mkdirSync('/tmp/starus/frames',{recursive:true});
for(let f=0;f<n;f++){
  const t=(f/FPS).toFixed(3);
  await send('Page.navigate',{url:`file:///tmp/starus/star.html?t=${t}`});
  // wait for load
  for(let i=0;i<200;i++){if(events.some(e=>e.method==='Page.loadEventFired'))break;await sleep(10)}
  events.length=0;await sleep(60);
  const r=await send('Page.captureScreenshot',{format:'png',clip:{x:0,y:0,width:1200,height:640,scale:2}});
  fs.writeFileSync(`/tmp/starus/frames/f${String(f).padStart(3,'0')}.png`,Buffer.from(r.result.data,'base64'));
  process.stdout.write(`\r${f+1}/${n}`);
}
console.log();chrome.kill();process.exit(0);
