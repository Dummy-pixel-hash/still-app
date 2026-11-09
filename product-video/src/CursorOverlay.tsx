import React from 'react';
import {cursorState,type CursorTrack} from './cursor-motion';

/** Screen-space pointer: its 24px size does not grow with the product camera. */
export const CursorOverlay:React.FC<{track:CursorTrack;seconds:number;map:(p:{x:number;y:number})=>{x:number;y:number}}> = ({track,seconds,map}) => {
  const state=cursorState(track,seconds),point=map(state);
  const isText=state.kind==='text',isHand=state.kind==='pointer';
  const offset=isText?{x:5,y:12}:isHand?{x:8,y:2}:{x:2,y:2};
  return <div style={{position:'absolute',left:point.x-offset.x,top:point.y-offset.y,opacity:state.opacity,pointerEvents:'none',zIndex:5,width:24,height:30,filter:'drop-shadow(0px 1px 1px #0008)'}}>
    {isText?<svg width={11} height={25} viewBox="0 0 11 25"><path d="M2 2h7M5.5 2v21M2 23h7" fill="none" stroke="white" strokeWidth={3}/><path d="M2 2h7M5.5 2v21M2 23h7" fill="none" stroke="#111" strokeWidth={1.2}/></svg>:
      isHand?<svg width={23} height={28} viewBox="0 0 23 28"><path d="M6 13V4c0-3 4-3 4 0v7-3c0-2.7 4-2.7 4 0v4-2c0-2.5 4-2.5 4 0v4-1c0-2.3 4-2.3 4 0v6c0 4-2.5 7-3 8H9c-.5-3-4-5-6-9-1.6-3.2 1.2-5.3 3-2Z" fill="#fff" stroke="#171717" strokeWidth={1.3} strokeLinejoin="round"/></svg>:
      <svg width={24} height={30} viewBox="0 0 24 30"><path d="M2 2v23l5.6-5.7 4.8 10 4.4-2-4.7-9.8H21Z" fill="white" stroke="#171717" strokeWidth={1.3} strokeLinejoin="round"/></svg>}
  </div>;
};
