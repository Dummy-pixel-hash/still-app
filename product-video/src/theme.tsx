import React, {useEffect, useState} from 'react';
import {cancelRender, continueRender, delayRender, Img, staticFile} from 'remotion';

export const theme = {
  ink: '#050505',
  paper: '#e2dce5',
  red: '#ff4a4a',
  muted: '#99929f',
  amber: '#efc281',
  green: '#a7d5a3',
  sans: 'Still Sans, Arial, sans-serif',
  serif: 'Still Display, Georgia, serif',
  mono: 'Still Mono, monospace',
};

export const FontLoader: React.FC = () => {
  const [handle] = useState(() => delayRender('Loading Still’s local typefaces'));
  useEffect(() => {
    const faces = [
      new FontFace('Still Sans', `url("${staticFile('fonts/geist-gyByhwUxId8gMEwcGFU.woff2')}")`, {weight:'100 900'}),
      new FontFace('Still Display', `url("${staticFile('fonts/instrumentserif-jizBRFtNs2ka5fXjeivQ4LroWlx-6zUTjg.woff2')}")`),
      new FontFace('Still Mono', `url("${staticFile('fonts/geistmono-or3nQ6H-1_WfwkMZI_qYFrcdmg.woff2')}")`, {weight:'100 900'}),
    ];
    Promise.all(faces.map(async face => {await face.load(); document.fonts.add(face);})).then(() => continueRender(handle)).catch(cancelRender);
  }, [handle]);
  return <style>{'* {box-sizing:border-box;} body {margin:0;}'}</style>;
};

/** Crop only the transparent padding of Still's actual shipped SVG. */
export const LogoMark: React.FC<{size?: number}> = ({size = 48}) => <div style={{width:size,height:size,position:'relative',overflow:'hidden',flexShrink:0}}>
  <Img src={staticFile('brand/still-terminal-icon.svg')} style={{position:'absolute',width:size*310/220,height:size*330/220,left:-size*45/220,top:-size*58/220}} />
</div>;

export const Wordmark: React.FC<{size?: number; dark?: boolean}> = ({size = 42, dark = false}) => <div style={{display:'flex',alignItems:'center',gap:size*.22,color:dark?theme.ink:theme.paper}}>
  <LogoMark size={size*.9}/><span style={{fontFamily:theme.serif,fontSize:size,letterSpacing:'-.045em',lineHeight:1}}>Still</span>
</div>;
