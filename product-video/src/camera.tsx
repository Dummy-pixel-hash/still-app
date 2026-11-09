import React from 'react';
import {Img, OffthreadVideo, staticFile, useCurrentFrame, useVideoConfig} from 'remotion';
import {fitPose, type Pose} from './motion';
import {CursorOverlay} from './CursorOverlay';
import type {CursorTrack} from './cursor-motion';

type Box = {x:number; y:number; width:number; height:number};
type Source = {src:string; video?:boolean; trim?:number; rate?:number; cursor?:CursorTrack};

/** Camera coordinates are in the actual captured UI's 1440×780 CSS-pixel space. */
export const AppView: React.FC<{
  source:Source; pose:Pose; box?:Box; radius?:number; style?:React.CSSProperties; constrain?:boolean;
}> = ({source,pose,box={x:92,y:174,width:1736,height:828},radius=18,style,constrain=true}) => {
  const {fps}=useVideoConfig();
  const frame=useCurrentFrame();
  const zoom=pose.zoom;
  const {cx,cy}=constrain?fitPose(pose,box):pose;
  const mediaStyle:React.CSSProperties={width:1440,height:780,display:'block'};
  return <div style={{position:'absolute',left:box.x,top:box.y,width:box.width,height:box.height,overflow:'hidden',borderRadius:radius,background:'#050505',border:'1px solid #383339',...style}}>
    <div style={{position:'absolute',left:box.width/2-cx*zoom,top:box.height/2-cy*zoom,width:1440,height:780,scale:`${zoom}`,transformOrigin:'0 0'}}>
      {source.video ? <OffthreadVideo muted src={staticFile(source.src)} trimBefore={Math.round((source.trim||0)*fps)} playbackRate={source.rate||1} style={mediaStyle}/> : <Img src={staticFile(source.src)} style={mediaStyle}/>}
    </div>
    {source.cursor&&<CursorOverlay track={source.cursor} seconds={frame/fps*(source.rate||1)+(source.trim||0)} map={p=>({x:box.width/2+(p.x-cx)*zoom,y:box.height/2+(p.y-cy)*zoom})}/>}
  </div>;
};
