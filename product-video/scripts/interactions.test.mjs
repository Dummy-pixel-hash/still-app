import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {cursorPosition,cursorState} from '../src/cursor-motion.ts';

const manifest=JSON.parse(readFileSync(new URL('../public/captures/v4/manifest.json',import.meta.url),'utf8'));

test('every app clip is sampled and encoded natively at 60fps with enough transition handles',()=>{
  const required={compose:4.5+14/30,search:3.5+18/30,todos:4+12/30,approval:3.5+14/30,changes:4.5+18/30};
  for(const [name,duration] of Object.entries(required)){
    const clip=manifest.clips[name];assert.ok(clip,`Missing ${name}`);
    assert.equal(clip.fps,60);assert.ok(clip.duration>=duration);
    assert.equal(clip.frames,Math.round(clip.duration*60));
    assert.equal(clip.cursor.kinds.length,clip.frames);
    const probe=JSON.parse(execFileSync('ffprobe',['-v','error','-count_frames','-select_streams','v:0','-show_entries','stream=avg_frame_rate,nb_read_frames,width,height','-of','json',`public/${clip.file}`],{encoding:'utf8'}));
    assert.equal(probe.streams[0].avg_frame_rate,'60/1');
    assert.equal(Number(probe.streams[0].nb_read_frames),clip.frames);
    assert.equal(probe.streams[0].width,2160);assert.equal(probe.streams[0].height,1170);
  }
});

test('the Todo expands over distinct intermediate frames without text-layout height jumps',()=>{
  const audit=manifest.clips.todos.animationAudit;
  assert.ok(new Set(audit.map(a=>a.clip)).size>=18,'Too few intermediate panel shapes');
  assert.ok(Math.max(...audit.map(a=>a.textHeight))-Math.min(...audit.map(a=>a.textHeight))<.1);
  assert.ok(Math.max(...audit.map(a=>a.textWidth))-Math.min(...audit.map(a=>a.textWidth))<.1);
  assert.ok(Math.max(...audit.map(a=>a.width))-Math.min(...audit.map(a=>a.width))<.1);
  assert.ok(audit.at(-1).height-audit[0].height>150);
  for(let i=1;i<audit.length;i++){
    assert.ok(audit[i].height>=audit[i-1].height-.1,'Panel height should not spring backward');
    assert.ok(audit[i].height-audit[i-1].height<60,'Panel layout still jumps in one frame');
    assert.ok(Math.abs(audit[i].scrollTop-audit[i-1].scrollTop)<65,'The conversation still jumps when the panel opens');
  }
  assert.equal(Number(audit.at(-1).opacity),1);
});

test('cursor arrives before each actual click and never clicks in mid-flight',()=>{
  for(const [name,clip] of Object.entries(manifest.clips)){
    for(const click of clip.cursor.clicks){
      const moves=clip.cursor.moves.filter(m=>m.start<=click);
      const move=moves.at(-1);assert.ok(move,`${name}: click has no approach`);
      assert.ok(click-move.end>=.049,`${name}: click precedes pointer settling`);
      const p=cursorPosition(clip.cursor,click);
      assert.ok(Math.hypot(p.x-move.to.x,p.y-move.to.y)<.001);
    }
  }
});

test('pointer paths are continuous at 60fps and do not retain 4-step screencast jumps',()=>{
  for(const clip of Object.values(manifest.clips))for(const move of clip.cursor.moves){
    const positions=[];
    for(let t=move.start;t<move.end;t+=1/60)positions.push(cursorPosition(clip.cursor,t));
    assert.ok(positions.length>=20);
    let longest=0;
    for(let i=1;i<positions.length;i++)longest=Math.max(longest,Math.hypot(positions[i].x-positions[i-1].x,positions[i].y-positions[i-1].y));
    const travel=Math.hypot(move.to.x-move.from.x,move.to.y-move.from.y);
    assert.ok(longest<travel*.13+1,'A pointer move still contains a large frame jump');
  }
});

test('cursor has no click pulse and its presentation size is independent of camera zoom',()=>{
  const source=readFileSync(new URL('../src/CursorOverlay.tsx',import.meta.url),'utf8');
  assert.match(source,/width:24,height:30/);
  assert.doesNotMatch(source,/width:.*zoom|height:.*zoom/);
  assert.doesNotMatch(source,/scale:|press/);
  const track=manifest.clips.todos.cursor;
  for(let t=0;t<4;t+=1/60){const state=cursorState(track,t);assert.ok(state.opacity>=0&&state.opacity<=1);assert.ok(Number.isFinite(state.x)&&Number.isFinite(state.y));}
});
