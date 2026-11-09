import {createRequire} from 'node:module';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const require = createRequire(new URL('../../package.json', import.meta.url));
const {chromium} = require('playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ffmpeg = process.env.FFMPEG || 'ffmpeg';
const base = process.env.STILL_CAPTURE_URL || 'http://localhost:1420';
const only = process.argv[2];
let manifest = {viewport: {width: 1440, height: 810}, page: {width: 1440, height: 780}, clips: {}};
if (only) manifest = JSON.parse(await readFile(path.join(root,'public/captures/v3/manifest.json'),'utf8'));
const browser = await chromium.launch({headless: true});

async function pageFor(scenario) {
  const context = await browser.newContext({viewport: {width:2160,height:1215}, deviceScaleFactor:1});
  const page = await context.newPage();
  page.setDefaultTimeout(6000);
  await page.goto(`${base}/tests-agents/fixture.html?demo&scenario=${scenario}`, {waitUntil: 'networkidle'});
  await page.addStyleTag({content:'html { zoom:1.5; }'});
  await page.evaluate(() => document.fonts.ready);
  await page.locator('.agent-thread-open[aria-current="page"]').waitFor();
  await page.waitForTimeout(350);
  await page.evaluate(() => {
    const pointer = document.createElement('div');
    pointer.id = 'film-pointer';
    pointer.innerHTML = '<svg width="27" height="34" viewBox="0 0 27 34"><path d="M3 2v25l6-6 5 11 5-2-5-10h9Z" fill="white" stroke="#161316" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    pointer.style.cssText = 'position:fixed;left:0;top:0;z-index:2147483647;pointer-events:none;opacity:0;filter:drop-shadow(0 3px 4px #0009)';
    document.body.append(pointer);
    window.addEventListener('mousemove', e => {
      pointer.style.opacity = '1';
      pointer.style.transform = `translate(${e.clientX/1.5}px,${e.clientY/1.5}px)`;
    });
    window.addEventListener('mousedown', e => {
      const ring = document.createElement('div');
      ring.style.cssText = `position:fixed;left:${e.clientX/1.5 - 24}px;top:${e.clientY/1.5 - 24}px;width:48px;height:48px;border:2px solid #ff4a4a;border-radius:50%;pointer-events:none;z-index:2147483646`;
      document.body.append(ring);
      ring.animate([{transform:'scale(.25)',opacity:1},{transform:'scale(1.35)',opacity:0}], {duration:400}).onfinish = () => ring.remove();
    });
  });
  return {context, page};
}

async function moveTo(page, locator, steps = 4) {
  const b = await locator.boundingBox();
  if (!b) throw new Error('Cannot point to a missing UI control');
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, {steps});
  return b;
}

async function click(page, locator) {
  await moveTo(page, locator);
  await page.waitForTimeout(100);
  await locator.click();
}

async function saveStill(page, name, selectors = {}) {
  await page.waitForTimeout(300);
  await page.evaluate(() => { document.querySelector('#film-pointer').style.opacity = '0'; });
  await page.locator('.agent-workspace').screenshot({path: path.join(root, 'public/captures/v3', `${name}.png`)});
  const boxes = await page.evaluate(selectors => Object.fromEntries(Object.entries(selectors).map(([key, s]) => {
    const r = document.querySelector(s)?.getBoundingClientRect();
    return [key, r ? {x:r.x/1.5, y:r.y/1.5-30, width:r.width/1.5, height:r.height/1.5} : null];
  })), selectors);
  return boxes;
}

async function record(name, scenario, setup, action) {
  if (only && only !== name) return;
  const {context, page} = await pageFor(scenario);
  if (setup) await setup(page);
  const folder = path.join(root, 'out/capture', name);
  await mkdir(folder, {recursive:true});
  const client = await context.newCDPSession(page);
  const frames = [], pending = [], events = [];
  client.on('Page.screencastFrame', ({data, sessionId, metadata}) => {
    const filename = path.join(folder, `${String(frames.length).padStart(5,'0')}.jpg`);
    frames.push({filename, time:metadata.timestamp});
    pending.push(writeFile(filename, Buffer.from(data, 'base64')));
    void client.send('Page.screencastFrameAck', {sessionId});
  });
  const cue = label => events.push({label, at: Date.now()/1000 - frames[0].time});
  const firstFrame = new Promise(resolve => client.once('Page.screencastFrame', resolve));
  await client.send('Page.startScreencast', {format:'jpeg', quality:96, maxWidth:2160, maxHeight:1215, everyNthFrame:1});
  await page.mouse.move(5, 5);
  await firstFrame;
  await page.waitForTimeout(220);
  if (!frames.length) throw new Error(`No capture frames for ${name}`);
  cue('start');
  const boxes = await action(page, cue);
  await page.mouse.move(2130, 1185, {steps:3});
  await page.waitForTimeout(250);
  const end = Date.now()/1000;
  await client.send('Page.stopScreencast');
  await Promise.all(pending);
  const concat = frames.map((f,i) => `file '${f.filename}'\nduration ${Math.max(1/60, (frames[i+1]?.time || end) - f.time).toFixed(6)}`).join('\n') + `\nfile '${frames.at(-1).filename}'\n`;
  const list = path.join(folder, 'frames.ffconcat');
  await writeFile(list, concat);
  const info = JSON.parse(execFileSync('ffprobe', ['-v','quiet','-show_entries','stream=width,height','-of','json',frames[0].filename], {encoding:'utf8'}));
  const cut = Math.round(info.streams[0].height * 30 / 810);
  const file = path.join(root, 'public/footage', `${name}.mp4`);
  execFileSync(ffmpeg, ['-hide_banner','-loglevel','error','-y','-f','concat','-safe','0','-i',list,'-vf',`crop=iw:ih-${cut}:0:${cut},fps=30,scale=2160:1170`,'-c:v','libopenh264','-b:v','12M','-g','30','-pix_fmt','yuv420p','-movflags','+faststart','-an',file], {stdio:'inherit'});
  const metadata = JSON.parse(execFileSync('ffprobe', ['-v','quiet','-show_entries','format=duration','-of','json',file], {encoding:'utf8'}));
  manifest.clips[name] = {file:`footage/${name}.mp4`, duration:Number(metadata.format.duration), events, boxes};
  await writeFile(path.join(root,'public/captures/v3/manifest.json'), JSON.stringify(manifest,null,2));
  console.log(name, JSON.stringify(manifest.clips[name]));
  await context.close();
}

await mkdir(path.join(root,'public/footage'), {recursive:true});
await mkdir(path.join(root,'public/captures/v3'), {recursive:true});

try {
  // Each recording runs against an isolated, synthetic fixture profile. No SSH or live data.
  await record('compose', 'conversation', async page => {
    await page.locator('.agent-composer').click({position:{x:170,y:8}});
    await page.getByRole('textbox',{name:'Message agent'}).focus();
    await page.waitForTimeout(500);
  }, async (page,cue) => {
    await page.waitForTimeout(300);
    cue('open-model');
    await click(page,page.locator('.agent-model-trigger'));
    cue('model-open');
    await page.waitForTimeout(650);
    cue('select-model');
    await click(page,page.getByRole('option',{name:'Claude Opus 4',exact:true}));
    cue('model-selected');
    await page.waitForTimeout(300);
    await click(page,page.getByRole('textbox',{name:'Message agent'}));
    cue('type');
    await page.keyboard.type('Make search work with Ctrl+K and Cmd+K.',{delay:42});
    cue('typed');
    await page.waitForTimeout(800);
    return await saveStill(page,'compose',{composer:'.agent-composer',model:'.agent-model-trigger'});
  });

  await record('search', 'conversation', null, async (page,cue) => {
    await page.waitForTimeout(300);
    await click(page,page.getByRole('textbox',{name:'Search conversations'}));
    cue('type');
    await page.keyboard.type('reconnect',{delay:95});
    cue('filtered');
    await page.waitForTimeout(500);
    cue('open-thread');
    await click(page,page.getByRole('button',{name:/^Fix reconnect on wake ·/}));
    cue('thread-opened');
    await page.waitForTimeout(950);
    return await saveStill(page,'search',{sidebar:'.agent-sidebar',reply:'.agent-conversation'});
  });

  await record('todos', 'todos', null, async (page,cue) => {
    await page.waitForTimeout(450);
    cue('expand');
    await click(page,page.getByRole('button',{name:'2 of 4 Todos done. Expand list',exact:true}));
    cue('expanded');
    await page.waitForTimeout(1000);
    const boxes = await saveStill(page,'todos',{todos:'.agent-todo-card'});
    cue('progress');
    await page.evaluate(() => {
      const h=window.agentFixture, row=window.agentThreadRows.find(r=>r.executionId==='demo-conversation-1');
      const next=structuredClone(row.todos);
      next.revision+=1; next.activeId='demo-todo-4';
      const task=next.items.find(t=>t.id==='demo-todo-3');task.status='completed'; task.durationMs=64000;
      const last=next.items.find(t=>t.id==='demo-todo-4');last.startedAt=Date.now();last.detail='Preparing the provider and release checks…';
      h.emit('demo-conversation-1',{type:'todos',todos:next,todoSync:{state:'current'}});
    });
    await page.waitForTimeout(1050);
    await saveStill(page,'todos-progress');
    return boxes;
  });

  await record('approval', 'approval', async page => {
    await page.getByRole('button',{name:'Expand request',exact:true}).click();
    await page.waitForTimeout(500);
  }, async (page,cue) => {
    await page.waitForTimeout(750);
    const boxes = await saveStill(page,'approval',{request:'.agent-request-card.is-expanded',allow:'.agent-request-card.is-expanded .agent-primary'});
    cue('approve');
    await click(page,page.getByRole('button',{name:'Allow once',exact:true}));
    cue('approved');
    await page.waitForTimeout(1000);
    await saveStill(page,'approved');
    return boxes;
  });

  await record('changes', 'conversation', null, async (page,cue) => {
    await page.waitForTimeout(400);
    cue('review');
    await click(page,page.getByRole('button',{name:'Review 2 changed files',exact:true}));
    cue('review-open');
    await page.waitForTimeout(1100);
    const boxes = await saveStill(page,'changes',{diff:'.agent-review',files:'.agent-review-files'});
    cue('choose-css');
    await click(page,page.getByRole('button',{name:'src/styles/sidebar.css, 1 reported edit',exact:true}));
    cue('css-open');
    await page.waitForTimeout(1000);
    await saveStill(page,'changes-css');
    return boxes;
  });

  const {context,page} = await pageFor('conversation');
  await saveStill(page,'workspace',{sidebar:'.agent-sidebar'});
  await page.goto(`${base}/tests-agents/fixture.html?workspace`,{waitUntil:'networkidle'});
  await page.evaluate(()=>document.fonts.ready);
  await page.screenshot({path:path.join(root,'public/captures/v3/terminal-workspace.png')});
  await context.close();
  await writeFile(path.join(root,'public/captures/v3/manifest.json'), JSON.stringify(manifest,null,2));
} finally {
  await browser.close();
}
