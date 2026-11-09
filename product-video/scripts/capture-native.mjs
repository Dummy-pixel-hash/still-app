import {createRequire} from 'node:module';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {cursorPosition} from '../src/cursor-motion.ts';

const require=createRequire(new URL('../../package.json',import.meta.url));
const {chromium}=require('playwright');
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const base=process.env.STILL_CAPTURE_URL||'http://localhost:1420';
const FPS=60,only=process.argv[2],ffmpeg=process.env.FFMPEG||'ffmpeg';
const manifestPath=path.join(root,'public/captures/v4/manifest.json');
let manifest={version:4,fps:FPS,page:{width:1440,height:780},method:'one screenshot per virtual-time frame; no screencast or frame interpolation',clips:{}};
if(only)try{manifest=JSON.parse(await readFile(manifestPath,'utf8'));}catch{}
await mkdir(path.dirname(manifestPath),{recursive:true});
await mkdir(path.join(root,'public/footage/v4'),{recursive:true});
const browser=await chromium.launch({headless:true});

const config={
  compose:{scenario:'conversation',duration:5.2,initial:{x:800,y:645},visibleUntil:2.6},
  search:{scenario:'conversation',duration:4.2,initial:{x:215,y:340},visibleUntil:3.35},
  todos:{scenario:'todos',duration:4.7,initial:{x:1110,y:648},visibleUntil:2.25},
  approval:{scenario:'approval',duration:4.2,initial:{x:760,y:440},visibleUntil:3.4},
  changes:{scenario:'conversation',duration:5.2,initial:{x:1040,y:480},visibleUntil:3.5},
};

async function prepare(name,cfg){
  const context=await browser.newContext({viewport:{width:1440,height:810},deviceScaleFactor:1.5});
  const page=await context.newPage();page.setDefaultTimeout(6000);
  // Freeze this browser's loaded source during a take. Vite otherwise reloads
  // the test page when capture assets are written inside the same repository.
  // CSS still uses Vite's real emitted stylesheet content via these helpers.
  await page.route('**/@vite/client*',route=>route.fulfill({contentType:'application/javascript',body:`
    const styles=new Map();
    export function createHotContext(){return {data:{},accept(){},dispose(){},prune(){},decline(){},invalidate(){},on(){},off(){},send(){}};}
    export function updateStyle(id,content){let style=styles.get(id);if(!style){style=document.createElement('style');style.dataset.viteDevId=id;styles.set(id,style);document.head.append(style);}style.textContent=content;}
    export function removeStyle(id){styles.get(id)?.remove();styles.delete(id);}
    export function injectQuery(url,query){return url+(url.includes('?')?'&':'?')+query;}
  `}));
  await page.goto(`${base}/tests-agents/fixture.html?demo&scenario=${cfg.scenario}`,{waitUntil:'networkidle'});
  page.on('framenavigated',frame=>{if(frame===page.mainFrame())console.log(`Unexpected navigation during ${name}: ${frame.url()}`);});
  await page.evaluate(()=>document.fonts.ready);
  await page.locator('.agent-thread-open[aria-current="page"]').waitFor();
  if(name==='compose'){
    await page.locator('.agent-composer').click({position:{x:170,y:8}});
    await page.getByRole('textbox',{name:'Message agent'}).focus();
  }
  if(name==='approval')await page.getByRole('button',{name:'Expand request',exact:true}).click();
  await page.waitForTimeout(650);
  // This is a FILM-ONLY layout adapter. The production UI and its source files
  // remain unchanged. It prevents Todo text rewrapping at 140→800px during reveal.
  if(name==='todos')await page.addStyleTag({content:'.agent-todos,.agent-todos-states,.agent-todos-state-clip{transition:none!important}'});
  await page.clock.install();
  await page.clock.pauseAt(new Date(await page.evaluate(()=>Date.now()+100)));
  const client=await context.newCDPSession(page);
  await client.send('Animation.enable');
  await client.send('Animation.setPlaybackRate',{playbackRate:0});
  await page.evaluate(()=>{
    window.filmTake={time:0,starts:new Map(),sample(t){
      this.time=t;
      for(const a of document.getAnimations()){
        if(!this.starts.has(a)&&a.playState==='finished')continue;
        if(!this.starts.has(a)){a.pause();this.starts.set(a,{at:t,done:false});}
        const s=this.starts.get(a),end=a.effect?.getComputedTiming().endTime;
        a.currentTime=t-s.at;
        if(Number.isFinite(end)&&t-s.at>=end&&!s.done){s.done=true;try{a.finish();}catch{}}
      }
    }};
    // Finish arrival animations before starting the take; preserve ambient loops.
    for(const a of document.getAnimations())if(Number.isFinite(a.effect?.getComputedTiming().endTime))try{a.finish();}catch{}
    window.filmTake.sample(0);
  });
  await page.mouse.move(cfg.initial.x,cfg.initial.y+30);
  return {context,page};
}

function locatorFor(page,key){
  const locators={model:()=>page.locator('.agent-model-trigger'),opus:()=>page.getByRole('option',{name:'Claude Opus 4',exact:true}),
    input:()=>page.getByRole('textbox',{name:'Message agent'}),search:()=>page.getByRole('textbox',{name:'Search conversations'}),
    thread:()=>page.getByRole('button',{name:/^Fix reconnect on wake ·/}),todo:()=>page.getByRole('button',{name:'2 of 4 Todos done. Expand list',exact:true}),
    allow:()=>page.getByRole('button',{name:'Allow once',exact:true}),review:()=>page.getByRole('button',{name:'Review 2 changed files',exact:true}),
    css:()=>page.getByRole('button',{name:'src/styles/sidebar.css, 1 reported edit',exact:true})};
  return locators[key]();
}

async function click(page,key){
  // The pointer has already arrived through its sampled path. Dispatch a real
  // browser click without an actionability wait shifting it in wall-clock time.
  await page.mouse.down();await page.mouse.up();
}

async function expandTodo(page){
  const previous=await page.locator('.agent-todo-progress-pill').boundingBox();
  await page.evaluate(()=>{
    const pill=document.querySelector('.agent-todo-progress-pill');
    const ghost=pill.cloneNode(true),r=pill.getBoundingClientRect();
    const copy=(a,b)=>{const s=getComputedStyle(a);for(const property of s)b.style.setProperty(property,s.getPropertyValue(property));[...a.children].forEach((child,i)=>copy(child,b.children[i]));};
    copy(pill,ghost);ghost.id='film-todo-label';
    for(const child of ghost.querySelectorAll('*'))child.style.pointerEvents='none';
    Object.assign(ghost.style,{position:'fixed',left:`${r.x}px`,top:`${r.y}px`,margin:'0',zIndex:'10000',pointerEvents:'none'});
    document.body.append(ghost);
  });
  await page.mouse.down();await page.mouse.up();
  await page.evaluate(before=>{
    const panel=document.querySelector('.agent-todos.is-expanded'),r=panel.getBoundingClientRect();
    const left=Math.max(0,before.x-r.x),right=Math.max(0,r.right-before.x-before.width);
    panel.style.overflow='hidden';
    // Animate the real layout height as well as the horizontal mask. Otherwise
    // the conversation viewport jumps immediately to its final scroll position.
    panel.animate([
      {height:`${before.height}px`,clipPath:`inset(0px ${right}px 0px ${left}px round 17px)`},
      {height:`${r.height}px`,clipPath:'inset(0px 0px 0px 0px round 14px)'}
    ],{duration:340,easing:'cubic-bezier(.22,1,.36,1)',fill:'both'});
    const card=panel.querySelector('.agent-todo-card');
    card.animate([{opacity:0,transform:'translateY(7px)'},{opacity:1,transform:'translateY(0px)'}],{duration:220,delay:65,easing:'cubic-bezier(.22,1,.36,1)',fill:'both'});
    const ghost=document.querySelector('#film-todo-label');
    ghost.animate([{opacity:1},{opacity:0}],{duration:110,fill:'forwards'}).onfinish=()=>ghost.remove();
  },previous);
}

function typing(text,start,gaps){let frame=start;return [...text].map((char,i)=>{const entry={frame,char};frame+=gaps[i%gaps.length];return entry;});}

async function record(name,cfg){
  const {context,page}=await prepare(name,cfg);
  const folder=path.join(root,'out/native-capture',name);await mkdir(folder,{recursive:true});
  const cursor={fps:FPS,initial:cfg.initial,moves:[],clicks:[],kinds:[],visibleUntil:cfg.visibleUntil};
  const events=[],audit=[],keyTimes=[];
  const cue=(label,frame)=>events.push({label,at:frame/FPS});
  async function move(frame,end,key,offset){
    const r=await locatorFor(page,key).boundingBox();if(!r)throw new Error(`Missing ${name}/${key}`);
    const from=cursorPosition(cursor,frame/FPS),to={x:r.x+r.width*(offset?.x??.5),y:r.y+r.height*(offset?.y??.5)-30};
    cursor.moves.push({start:frame/FPS,end:end/FPS,from,to,bend:Math.min(9,Math.hypot(to.x-from.x,to.y-from.y)*.025)*(cursor.moves.length%2?-1:1)});
  }
  const text=name==='compose'?typing('Make search work with Ctrl+K and Cmd+K.',142,[3,2,3,4,2,3,3,2]):name==='search'?typing('reconnect',50,[4,5,4,6,4,4,5]):[];
  const total=Math.round(cfg.duration*FPS);
  for(let frame=0;frame<total;frame++){
    await page.clock.runFor(1000/FPS);
    await page.evaluate(t=>window.filmTake.sample(t),frame*1000/FPS);
    if(name==='compose'){
      if(frame===5)await move(frame,27,'model');
      if(frame===33){await click(page,'model');cursor.clicks.push(frame/FPS);cue('model-open',frame);}
      if(frame===65)await move(frame,88,'opus');
      if(frame===94){await click(page,'opus');cursor.clicks.push(frame/FPS);cue('model-selected',frame);}
      if(frame===105)await move(frame,127,'input',{x:.35,y:.27});
      if(frame===131){await click(page,'input');cursor.clicks.push(frame/FPS);}
    }
    if(name==='search'){
      if(frame===10)await move(frame,32,'search');
      if(frame===37){await click(page,'search');cursor.clicks.push(frame/FPS);}
      if(frame===112)await move(frame,135,'thread');
      if(frame===142){await click(page,'thread');cursor.clicks.push(frame/FPS);cue('thread-opened',frame);}
    }
    if(name==='todos'){
      if(frame===14)await move(frame,45,'todo');
      if(frame===51){await expandTodo(page);cursor.clicks.push(frame/FPS);cue('expanded',frame);}
      if(frame===85){const from=cursorPosition(cursor,frame/FPS);cursor.moves.push({start:frame/FPS,end:112/FPS,from,to:{x:1275,y:450},bend:7});}
      if(frame===156){
        await page.evaluate(()=>{
          const row=window.agentThreadRows.find(r=>r.executionId==='demo-conversation-1'),next=structuredClone(row.todos);
          next.revision++;next.activeId='demo-todo-4';Object.assign(next.items.find(t=>t.id==='demo-todo-3'),{status:'completed',durationMs:64000});
          Object.assign(next.items.find(t=>t.id==='demo-todo-4'),{startedAt:Date.now(),detail:'Preparing the provider and release checks…'});
          window.agentFixture.emit('demo-conversation-1',{type:'todos',todos:next,todoSync:{state:'current'}});
        });cue('progress',frame);
      }
    }
    if(name==='approval'){
      if(frame===122)await move(frame,151,'allow');
      if(frame===160){await click(page,'allow');cursor.clicks.push(frame/FPS);cue('approved',frame);}
    }
    if(name==='changes'){
      if(frame===4)await move(frame,28,'review',{x:.91,y:.5});
      if(frame===36){await click(page,'review');cursor.clicks.push(frame/FPS);cue('review-open',frame);}
      if(frame===150)await move(frame,177,'css');
      if(frame===184){await click(page,'css');cursor.clicks.push(frame/FPS);cue('css-open',frame);}
    }
    for(const char of text.filter(c=>c.frame===frame)){
      if(char===text[0])cue('type',frame);
      await page.keyboard.insertText(char.char);
      keyTimes.push(frame/FPS);
      if(char===text.at(-1))cue(name==='compose'?'typed':'filtered',frame);
    }
    const point=cursorPosition(cursor,frame/FPS);
    await page.mouse.move(point.x,point.y+30);
    const state=await page.evaluate(({time,x,y})=>{
      window.filmTake.sample(time);
      const el=document.elementFromPoint(x,y+30),kind=el?.closest('input,textarea,[contenteditable="true"]')?'text':el?getComputedStyle(el).cursor:'default';
      const todo=document.querySelector('.agent-todos.is-expanded');
      const line=todo?.querySelector('.agent-todo-readonly-title');
      return {kind,todo:todo?{clip:getComputedStyle(todo).clipPath,opacity:getComputedStyle(todo.querySelector('.agent-todo-card')).opacity,width:todo.getBoundingClientRect().width,height:todo.getBoundingClientRect().height,textHeight:line.getBoundingClientRect().height,textWidth:line.getBoundingClientRect().width,scrollTop:document.querySelector('.agent-conversation').scrollTop}:null};
    },{time:frame*1000/FPS,...point});
    cursor.kinds.push(state.kind);
    if(name==='todos'&&frame>=51&&frame<=78)audit.push({frame,...state.todo});
    await page.screenshot({path:path.join(folder,`${String(frame).padStart(5,'0')}.jpg`),type:'jpeg',quality:97,clip:{x:0,y:30,width:1440,height:780},animations:'allow'});
    if(frame%60===0)console.log(`${name}: sampled ${(frame/FPS).toFixed(0)}s / ${cfg.duration}s of native UI`);
  }
  const file=path.join(root,'public/footage/v4',`${name}.mp4`);
  execFileSync(ffmpeg,['-hide_banner','-loglevel','error','-y','-framerate',String(FPS),'-i',path.join(folder,'%05d.jpg'),'-frames:v',String(total),'-c:v','libopenh264','-b:v','18M','-g','60','-pix_fmt','yuv420p','-movflags','+faststart','-an',file],{stdio:'inherit'});
  manifest.clips[name]={file:`footage/v4/${name}.mp4`,fps:FPS,frames:total,duration:total/FPS,events,cursor,keyTimes,animationAudit:audit};
  await writeFile(manifestPath,JSON.stringify(manifest,null,2));
  console.log(`Finished ${name}: ${total} distinct time samples at 60fps, cursor rendered separately.`);
  await context.close();
}

try{for(const [name,cfg] of Object.entries(config))if(!only||only.split(',').includes(name))await record(name,cfg);}finally{await browser.close();}
