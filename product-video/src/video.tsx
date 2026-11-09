import React from 'react';
import {AbsoluteFill, Composition, Html5Audio, Img, interpolate, interpolateColors, spring, staticFile, useVideoConfig} from 'remotion';
import {TransitionSeries, linearTiming} from '@remotion/transitions';
import {wipe} from '@remotion/transitions/wipe';
import {AppView} from './camera';
import {at, clamp, MOTION_FPS, ramp, smooth, useMotionFrame} from './motion';
import {FontLoader, LogoMark, theme as T, Wordmark} from './theme';
import {softReveal} from './transitions';
import {recording} from './recordings';

export const SHOTS = [
  {name:'Vibe code. Not babysit.',from:0,duration:75},
  {name:'Choose a model · type a real prompt',from:75,duration:135},
  {name:'Search · open a saved conversation',from:210,duration:105},
  {name:'Expand the real Todo list · see an update',from:315,duration:120},
  {name:'Coffee break',from:435,duration:45},
  {name:'Read an approval · Allow once',from:480,duration:105},
  {name:'Open Changes · inspect two actual file diffs',from:585,duration:135},
  {name:'Close the laptop',from:720,duration:90},
  {name:'Still · closing lockup',from:810,duration:90},
] as const;

const Scene:React.FC<{children:React.ReactNode;light?:boolean;red?:boolean;background?:string}> = ({children,light=false,red=false,background}) => <AbsoluteFill style={{background:background||(red?T.red:light?T.paper:T.ink),color:light||red?T.ink:T.paper,fontFamily:T.sans,overflow:'hidden'}}>{children}</AbsoluteFill>;

const Footnote:React.FC<{light?:boolean;right?:string}> = ({light=false,right}) => <div style={{position:'absolute',left:96,right:96,bottom:29,display:'flex',justifyContent:'space-between',alignItems:'center',fontFamily:T.mono,fontSize:18,color:light?'#6d656e':'#8c858e',letterSpacing:'-.015em'}}>
  <span>Actual Still UI · demo data</span><span>{right}</span>
</div>;

const Heading:React.FC<{children:React.ReactNode;f:number;light?:boolean;label?:string}> = ({children,f,light,label}) => <>
  <div style={{position:'absolute',left:96,top:64,display:'flex',alignItems:'baseline',gap:28,zIndex:3,opacity:ramp(f,0,12),translate:`0px ${ramp(f,0,24,18,0)}px`}}>
    <span style={{fontSize:72,lineHeight:1.03,fontWeight:550,letterSpacing:'-.055em',whiteSpace:'nowrap'}}>{children}</span>
    {label&&<span style={{fontFamily:T.mono,fontSize:19,color:light?'#6d656e':T.muted,letterSpacing:'-.02em'}}>{label}</span>}
  </div>
  <div style={{position:'absolute',right:96,top:68,zIndex:4}}><Wordmark size={40} dark={light}/></div>
</>;

const Rise:React.FC<{text:string;f:number;start?:number;size?:number;color?:string;weight?:number}> = ({text,f,start=0,size=200,color,weight=600}) => <div style={{fontSize:size,fontWeight:weight,lineHeight:1.02,letterSpacing:'-.075em',color,whiteSpace:'nowrap',paddingBottom:size*.09,overflow:'hidden'}}>
  {[...text].map((char,i)=><span key={i} style={{display:'inline-block',whiteSpace:'pre',opacity:ramp(f,start+i*.65,start+i*.65+7),translate:`0px ${ramp(f,start+i*.65,start+i*.65+19,size*.9,0)}px`}}>{char}</span>)}
</div>;

const Hook:React.FC = () => {
  const f=useMotionFrame();
  const second=ramp(f,27,31);
  return <Scene light background={interpolateColors(interpolate(f,[27,39],[0,1],{...clamp,easing:smooth}),[0,1],[T.paper,T.red])}>
    <div style={{position:'absolute',left:108,top:80}}><Wordmark size={54} dark/></div>
    <div style={{position:'absolute',right:110,top:102,fontFamily:T.mono,fontSize:22,letterSpacing:'-.03em'}}>REMOTE AGENTS. REAL LIFE.</div>
    <div style={{position:'absolute',left:106,top:340,opacity:1-second,translate:`0px ${-18*second}px`}}><Rise text="Vibe code." f={f} size={247}/><div style={{position:'absolute',right:-42,top:39,width:18,height:184,background:T.red,opacity:ramp(f,19,27,1,0)}}/></div>
    <div style={{position:'absolute',left:106,top:202,opacity:ramp(f,31,41)}}>
      <Rise text="Not" f={f} start={29} size={238}/>
      <div style={{marginTop:-25}}><Rise text="babysit." f={f} start={34} size={238}/></div>
    </div>
    <div style={{position:'absolute',left:116,bottom:93,fontSize:30,letterSpacing:'-.035em',opacity:ramp(f,10,22)*(1-second)}}>A home for the agents that do your work.</div>
    <div style={{position:'absolute',left:116,bottom:93,fontSize:30,letterSpacing:'-.035em',opacity:ramp(f,33,44)}}>Your server does the work. Your laptop doesn’t have to.</div>
    <div style={{position:'absolute',right:126,bottom:205,fontSize:180,lineHeight:1,rotate:`${ramp(f,43,67,-14,0)}deg`,translate:`${ramp(f,43,67,48,0)}px 0px`,opacity:ramp(f,43,54)}}>↘</div>
  </Scene>;
};

const Compose:React.FC = () => {
  const f=useMotionFrame();
  const pose=at(f,[
    {frame:0,cx:790,cy:494,zoom:1.45},
    {frame:46,cx:790,cy:494,zoom:1.45},
    {frame:84,cx:863,cy:590,zoom:1.72},
    {frame:134,cx:863,cy:590,zoom:1.72},
  ]);
  return <Scene><Heading f={f} label="01 / CHOOSE → ASK">Your agent. Your rules.</Heading>
    <AppView source={recording('compose')} pose={pose} style={{translate:`${ramp(f,0,26,42,0)}px 0px`}}/>
    <Footnote right="Model selection → a real typed prompt"/>
  </Scene>;
};

const Search:React.FC = () => {
  const f=useMotionFrame();
  const pose=at(f,[{frame:0,cx:153,cy:278,zoom:2.55},{frame:72,cx:153,cy:278,zoom:2.55},{frame:104,cx:153,cy:291,zoom:2.45}],{width:796,height:784});
  return <Scene light>
    <Heading f={f} light label="02 / FIND YOUR THREAD">Less tab archaeology.</Heading>
    <AppView source={recording('search')} pose={pose} box={{x:96,y:205,width:796,height:784}} radius={22} style={{boxShadow:'0 24px 44px #1710151b',translate:`0px ${ramp(f,0,27,26,0)}px`}}/>
    <div style={{position:'absolute',left:1010,top:341,width:800}}>
      <div style={{fontSize:116,fontWeight:550,letterSpacing:'-.07em',lineHeight:1.04,translate:`0px ${ramp(f,10,36,26,0)}px`,opacity:ramp(f,10,27)}}>Find it.<br/><span style={{color:'#8e828e'}}>Pick it up.</span></div>
      <div style={{fontSize:30,lineHeight:1.4,letterSpacing:'-.035em',maxWidth:630,marginTop:42,opacity:ramp(f,29,46)}}>Projects and conversations.<br/>Not another wall of forgotten tabs.</div>
      <div style={{marginTop:52,display:'flex',gap:18,alignItems:'center',opacity:ramp(f,45,59)}}>
        {['opencode','claude','codex'].map((id,i)=><div key={id} style={{width:70,height:70,display:'grid',placeItems:'center',background:T.ink,borderRadius:16,translate:`0px ${ramp(f,45+i*3,69+i*3,16,0)}px`}}><Img src={staticFile(`brand/${id}.svg`)} style={{width:35,height:35}}/></div>)}
        <span style={{fontSize:24,marginLeft:10,color:'#7c707c'}}>Your familiar tools.</span>
      </div>
    </div>
    <Footnote light right="Recorded search and navigation"/>
  </Scene>;
};

const Todos:React.FC = () => {
  const f=useMotionFrame();
  // Let the real panel finish opening before moving the product camera.
  const pose=at(f,[{frame:0,cx:864,cy:589,zoom:1.73},{frame:43,cx:864,cy:589,zoom:1.73},{frame:78,cx:864,cy:589,zoom:1.90},{frame:119,cx:864,cy:589,zoom:1.90}],{width:1736,height:817});
  return <Scene><Heading f={f} label="03 / FOLLOW ALONG">Know what’s moving.</Heading>
    <AppView source={recording('todos')} pose={pose} box={{x:92,y:185,width:1736,height:817}}/>
    <Footnote right="Agent-maintained Todos · progress, not a test verdict"/>
  </Scene>;
};

const Coffee:React.FC = () => {
  const f=useMotionFrame();
  const pop=spring({frame:f,fps:MOTION_FPS,config:{damping:24,stiffness:125}});
  return <Scene red>
    <div style={{position:'absolute',left:112,top:75}}><Wordmark size={48} dark/></div>
    <div style={{position:'absolute',left:106,top:320}}><Rise text="Coffee?" f={f} size={238}/><div style={{fontSize:41,letterSpacing:'-.045em',marginTop:22,opacity:ramp(f,9,20)}}>Your server’s got this.</div></div>
    <svg width={620} height={630} viewBox="0 0 620 630" style={{position:'absolute',right:96,top:176,scale:`${.9+.1*pop}`,rotate:`${-6+6*pop}deg`,opacity:ramp(f,0,14)}}>
      <g fill="none" stroke={T.ink} strokeWidth={12} strokeLinecap="round">
        {[0,1,2].map(i=><path key={i} d={`M${224+i*70} 200 C${160+i*70} 160,${285+i*70} 130,${220+i*70} 80`} strokeDasharray="150" strokeDashoffset={150-ramp(f,5+i*3,28+i*3,0,150)} opacity={.4}/>)}</g>
      <path d="M444 300h39c109 0 109 139 0 139h-39" fill="none" stroke={T.ink} strokeWidth={25}/>
      <path d="M155 276h291v140c0 86-44 128-146 128S155 502 155 416Z" fill={T.ink}/>
      <ellipse cx={300} cy={278} rx={145} ry={27} fill={T.ink}/>
      <ellipse cx={300} cy={281} rx={119} ry={12} fill={T.red}/>
      <path d="M128 568h350" stroke={T.ink} strokeWidth={17} strokeLinecap="round"/>
      <path d="m261 376 36 34-36 34m62 0h41" stroke={T.red} fill="none" strokeWidth={12} strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  </Scene>;
};

const Approval:React.FC = () => {
  const f=useMotionFrame();
  const pose=at(f,[{frame:0,cx:720,cy:390,zoom:1.85},{frame:46,cx:720,cy:390,zoom:1.85},{frame:69,cx:720,cy:390,zoom:1.90},{frame:104,cx:720,cy:390,zoom:1.90}]);
  return <Scene><Heading f={f} label="04 / PERMISSIONS">You get the final say.</Heading>
    <AppView source={recording('approval')} pose={pose}/>
    <Footnote right="Read the operation → Allow once"/>
  </Scene>;
};

const Changes:React.FC = () => {
  const f=useMotionFrame();
  // Keep the approved framing, but make the emphasis a single continuous glide.
  const pose=at(f,[
    {frame:0,cx:720,cy:390,zoom:1.2},
    {frame:30,cx:720,cy:390,zoom:1.2},
    {frame:56,cx:640,cy:390,zoom:1.36},
    {frame:94,cx:640,cy:390,zoom:1.36},
    {frame:126,cx:825,cy:405,zoom:1.62},
    {frame:134,cx:825,cy:405,zoom:1.62},
  ]);
  return <Scene><Heading f={f} label="05 / INSPECT THE DIFF">Less guessing. More shipping.</Heading>
    <AppView source={recording('changes')} pose={pose}/>
    <Footnote right="Actual file selection and syntax-colored changes"/>
  </Scene>;
};

const Laptop:React.FC = () => {
  const f=useMotionFrame();
  const close=interpolate(f,[20,62],[0,89],{...clamp,easing:smooth});
  return <Scene>
    <div style={{position:'absolute',left:0,right:0,top:95,textAlign:'center',fontSize:104,fontWeight:550,letterSpacing:'-.065em',translate:`0px ${ramp(f,0,25,28,0)}px`,opacity:ramp(f,0,15)}}>Close the laptop.</div>
    <div style={{position:'absolute',left:425,top:285,width:1070,height:580,perspective:2300,perspectiveOrigin:'50% 100%'}}>
      <div style={{position:'absolute',inset:0,borderRadius:'22px 22px 9px 9px',padding:14,background:'#1a171b',border:'2px solid #716872',transformOrigin:'50% 100%',rotate:`x ${-close}deg`,backfaceVisibility:'hidden'}}>
        <Img src={staticFile('captures/v3/workspace.png')} style={{width:'100%',height:'100%',objectFit:'cover',borderRadius:'9px 9px 2px 2px'}}/>
        <div style={{position:'absolute',top:5,left:'49.8%',width:5,height:5,background:'#777078',borderRadius:'50%'}}/>
      </div>
    </div>
    <div style={{position:'absolute',left:345,top:866,width:1230,height:18,borderRadius:'3px 3px 36px 36px',background:'linear-gradient(#a39aa5,#4e4853 45%,#2d2832)',boxShadow:'0 22px 65px #000'}}><div style={{position:'absolute',left:'42%',width:'16%',height:5,borderRadius:'0 0 8px 8px',background:'#353039'}}/></div>
    <div style={{position:'absolute',left:0,right:0,top:951,textAlign:'center',fontSize:31,color:T.muted,letterSpacing:'-.035em',opacity:ramp(f,48,68)}}>Remote work. Not laptop work.</div>
    <div style={{position:'absolute',right:96,top:68}}><Wordmark size={40}/></div>
    <Footnote right="Persistent remote workers · SSH + tmux terminals"/>
  </Scene>;
};

const Outro:React.FC = () => {
  const f=useMotionFrame();
  const p=spring({frame:f,fps:MOTION_FPS,config:{damping:28,stiffness:125}});
  return <Scene light>
    <div style={{position:'absolute',left:0,right:0,top:210,display:'flex',alignItems:'center',justifyContent:'center',gap:48,translate:`0px ${48*(1-p)}px`,opacity:ramp(f,0,15)}}><LogoMark size={148}/><div style={{fontFamily:T.serif,fontSize:330,lineHeight:1.1,letterSpacing:'-.055em'}}>Still<span style={{color:T.red}}>.</span></div></div>
    <div style={{position:'absolute',left:0,right:0,top:662,textAlign:'center',fontSize:49,fontWeight:450,letterSpacing:'-.045em',opacity:ramp(f,14,27),translate:`0px ${ramp(f,14,33,30,0)}px`}}>Your work. Right where you left it.</div>
    <div style={{position:'absolute',left:753,top:777,width:414,height:4,background:T.red,scale:`${ramp(f,20,40)} 1`,transformOrigin:'50% 50%'}}/>
    <div style={{position:'absolute',left:0,right:0,top:864,textAlign:'center',fontSize:27,fontFamily:T.mono,color:'#6d626e',letterSpacing:'-.035em',opacity:ramp(f,29,43)}}>github.com/Dummy-pixel-hash/still-app　↗</div>
    <div style={{position:'absolute',left:96,bottom:45,fontSize:21,color:'#786d79',fontFamily:T.mono}}>REMOTE AGENTS + PERSISTENT TERMINALS</div>
    <div style={{position:'absolute',right:96,bottom:45,fontSize:21,color:'#786d79',fontFamily:T.mono}}>Less babysitting. More living.</div>
  </Scene>;
};

const scenes=[Hook,Compose,Search,Todos,Coffee,Approval,Changes,Laptop,Outro];
const TodoInteraction:React.FC=()=> <><FontLoader/><Todos/></>;

/** Overlaps extend outgoing scenes, preserving every incoming shot's original beat. */
export const HANDOFFS = [
  {frames:18,kind:'wipe'},
  {frames:14,kind:'reveal'},
  {frames:18,kind:'wipe'},
  {frames:12,kind:'reveal'},
  {frames:14,kind:'reveal'},
  {frames:14,kind:'reveal'},
  {frames:18,kind:'wipe'},
  {frames:18,kind:'reveal'},
] as const;

export type FilmProps={music:boolean};
export const Film:React.FC<FilmProps> = ({music}) => {
  const {fps}=useVideoConfig();
  const deliveryRate=fps/MOTION_FPS;
  const children=SHOTS.flatMap((shot,i)=>{
    const Part=scenes[i];
    const handoff=HANDOFFS[i];
    const sequence=<TransitionSeries.Sequence key={shot.name} name={shot.name} durationInFrames={Math.round((shot.duration+(handoff?.frames||0))*deliveryRate)} premountFor={Math.round(20*deliveryRate)}><Part/></TransitionSeries.Sequence>;
    if(!handoff)return [sequence];
    const timing=linearTiming({durationInFrames:Math.round(handoff.frames*deliveryRate),easing:smooth});
    const transition=handoff.kind==='wipe'
      ? <TransitionSeries.Transition key={`handoff-${i}`} timing={timing} presentation={wipe({direction:'from-right'})}/>
      : <TransitionSeries.Transition key={`handoff-${i}`} timing={timing} presentation={softReveal({direction:i===3?'from-bottom':i===7?'from-top':'from-right'})}/>;
    return [sequence,transition];
  });
  return <AbsoluteFill style={{background:T.ink}}>
  <FontLoader/>
  <TransitionSeries>{children}</TransitionSeries>
  {music&&<Html5Audio src={staticFile('audio/still-groove.wav')} volume={.8} name="Original 120 BPM score"/>}
  <Html5Audio src={staticFile('audio/still-picture-sfx.wav')} volume={.8} name="Picture-locked clicks, typing, transitions"/>
</AbsoluteFill>;
};

export const RemotionRoot:React.FC = () => <>
  <Composition id="StillFilm" component={Film} durationInFrames={1800} fps={60} width={1920} height={1080} defaultProps={{music:true}}/>
  <Composition id="StillFilmNoMusic" component={Film} durationInFrames={1800} fps={60} width={1920} height={1080} defaultProps={{music:false}}/>
  <Composition id="StillFilm30fps" component={Film} durationInFrames={900} fps={30} width={1920} height={1080} defaultProps={{music:true}}/>
  <Composition id="OpeningCut" component={Film} durationInFrames={420} fps={60} width={1920} height={1080} defaultProps={{music:true}}/>
  <Composition id="TodoInteraction" component={TodoInteraction} durationInFrames={240} fps={60} width={1920} height={1080}/>
</>;
