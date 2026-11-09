import {Easing, interpolate, useCurrentFrame, useVideoConfig} from 'remotion';

/** Choreography stays in the approved 30-fps timebase; delivery can be 30 or 60 fps. */
export const MOTION_FPS = 30;
export const toMotionFrame = (frame:number,fps:number) => frame*MOTION_FPS/fps;
export const useMotionFrame = () => toMotionFrame(useCurrentFrame(),useVideoConfig().fps);
export const clamp = {extrapolateLeft:'clamp' as const, extrapolateRight:'clamp' as const};
export const out = Easing.bezier(.22, 1, .36, 1);

/** Zero velocity AND acceleration at both ends: no kick when a camera starts or stops. */
export const smooth = (t:number) => t*t*t*(t*(t*6-15)+10);
export const ramp = (f:number, a:number, b:number, from=0, to=1) => interpolate(f,[a,b],[from,to],{...clamp,easing:out});
export type Pose = {cx:number; cy:number; zoom:number};
export type CameraKey = Pose & {frame:number};
export type Viewport = {width:number; height:number};
export const defaultViewport:Viewport = {width:1736,height:828};

export const fitPose = (pose:Pose, box:Viewport):Pose => {
  const xMargin=Math.min(box.width/(2*pose.zoom),720);
  const yMargin=Math.min(box.height/(2*pose.zoom),390);
  return {...pose,cx:Math.max(xMargin,Math.min(1440-xMargin,pose.cx)),cy:Math.max(yMargin,Math.min(780-yMargin,pose.cy))};
};

export const at = (frame:number, keys:CameraKey[], viewport:Viewport=defaultViewport):Pose => {
  // Fit endpoints BEFORE interpolation. Clamping only at render time introduces
  // a visible change in velocity when the moving camera hits a screenshot edge.
  const fitted=keys.map(key=>({...key,...fitPose(key,viewport)}));
  const times=fitted.map(k=>k.frame);
  const options={...clamp,easing:smooth};
  return {
    cx:interpolate(frame,times,fitted.map(k=>k.cx),options),
    cy:interpolate(frame,times,fitted.map(k=>k.cy),options),
    zoom:Math.exp(interpolate(frame,times,fitted.map(k=>Math.log(k.zoom)),options)),
  };
};
