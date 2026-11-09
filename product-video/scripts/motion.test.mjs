import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {at,fitPose,smooth,toMotionFrame} from '../src/motion.ts';

const near = (a,b,tolerance=1e-6) => assert.ok(Math.abs(a-b)<=tolerance, `${a} differs from ${b}`);

test('camera easing is monotonic with zero velocity and acceleration at rest',()=>{
  near(smooth(0),0); near(smooth(1),1);
  for(let i=0;i<1000;i++) assert.ok(smooth((i+1)/1000)>=smooth(i/1000)-1e-12);
  const h=.0001;
  near((smooth(h)-smooth(0))/h,0,1e-6);
  near((smooth(1)-smooth(1-h))/h,0,1e-6);
  near((smooth(2*h)-2*smooth(h)+smooth(0))/(h*h),0,.01);
  near((smooth(1)-2*smooth(1-h)+smooth(1-2*h))/(h*h),0,.01);
});

test('60fps delivery has identical story timing plus genuine intermediate poses',()=>{
  for(const seconds of [0,.25,2.5,7,10.5,16,19.5,24,27,30]) {
    near(toMotionFrame(seconds*30,30),seconds*30);
    near(toMotionFrame(seconds*60,60),seconds*30);
  }
  near(toMotionFrame(151,60),75.5);
});

test('the camera glides to its target without zoom overshoot or a clamp-induced stop',()=>{
  const keys=[{frame:0,cx:790,cy:494,zoom:1.45},{frame:38,cx:863,cy:590,zoom:1.72}];
  let previous=at(0,keys);
  for(let frame=0;frame<=38;frame+=.5) {
    const pose=at(frame,keys);
    assert.ok(pose.zoom>=1.45-1e-9&&pose.zoom<=1.72+1e-9);
    assert.ok(pose.zoom>=previous.zoom-1e-9);
    const fitted=fitPose(pose,{width:1736,height:828});
    near(pose.cx,fitted.cx); near(pose.cy,fitted.cy);
    previous=pose;
  }
  near(at(-10,keys).zoom,1.45);
  near(at(90,keys).zoom,1.72);
});

test('overlapping scene handoffs preserve the approved beats and 30-second total',()=>{
  const source=readFileSync(new URL('../src/video.tsx',import.meta.url),'utf8');
  const shots=[...source.matchAll(/from:(\d+),duration:(\d+)/g)].map(m=>({from:Number(m[1]),duration:Number(m[2])}));
  const handoffs=[...source.matchAll(/\{frames:(\d+),kind:'(?:wipe|reveal)'\}/g)].map(m=>Number(m[1]));
  assert.equal(shots.length,9); assert.equal(handoffs.length,8);
  for(const fps of [30,60]) {
    const rate=fps/30;
    let cursor=0;
    for(const [i,shot] of shots.entries()) {
      near(cursor,shot.from*rate);
      const overlap=(handoffs[i]||0)*rate;
      assert.ok(overlap<shot.duration*rate);
      cursor+=(shot.duration+(handoffs[i]||0))*rate;
      cursor-=overlap;
    }
    near(cursor,30*fps);
  }
});
