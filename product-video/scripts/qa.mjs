import {bundle} from '@remotion/bundler';
import {openBrowser, renderStill, selectComposition} from '@remotion/renderer';
import {mkdir} from 'node:fs/promises';
import path from 'node:path';

const serveUrl = await bundle({entryPoint:path.resolve('src/index.tsx')});
const browser = await openBrowser('chrome');
const composition = await selectComposition({serveUrl,id:process.env.QA_COMPOSITION||'StillFilm',browserInstance:browser});
const frames = process.argv.slice(2).map(Number);
// Arguments remain in 30-fps story units, so the same checks work at 30 or 60 fps.
const targets = frames.length ? frames : [18,33,55,74,79,84,94,100,145,185,216,230,250,323,340,405,441,455,487,515,559,592,625,649,672,727,760,800,818,860,899];
const folder=`out/qa-smooth/${composition.id}`;
await mkdir(folder,{recursive:true});
try {
  for (let i=0;i<targets.length;i+=2) {
    const result = await Promise.allSettled(targets.slice(i,i+2).map(async frame => {
      await renderStill({serveUrl,composition,browserInstance:browser,frame:Math.round(frame*composition.fps/30),scale:.5,imageFormat:'png',output:`${folder}/${String(frame).padStart(4,'0')}.png`});
      console.log(`Inspected ${composition.id} at ${(frame/30).toFixed(3)}s`);
    }));
    for (const r of result) if (r.status==='rejected') throw r.reason;
  }
} finally {
  await browser.close({silent:true});
}
