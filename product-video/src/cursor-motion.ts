export type Point={x:number;y:number};
export type CursorMove={start:number;end:number;from:Point;to:Point;bend:number};
export type CursorTrack={fps:number;initial:Point;moves:CursorMove[];clicks:number[];kinds:string[];visibleUntil:number};

const unit=(t:number)=>Math.max(0,Math.min(1,t));
const ease=(t:number)=>t*t*t*(t*(t*6-15)+10);

/** A short, almost straight ballistic move; no floating pauses or target overshoot. */
export function cursorPosition(track:Pick<CursorTrack,'initial'|'moves'>,seconds:number):Point {
  let p=track.initial;
  for(const move of track.moves){
    if(seconds<move.start)return p;
    if(seconds>=move.end){p=move.to;continue;}
    const t=ease(unit((seconds-move.start)/(move.end-move.start)));
    const dx=move.to.x-move.from.x,dy=move.to.y-move.from.y,d=Math.hypot(dx,dy)||1;
    const nx=-dy/d,ny=dx/d;
    const a={x:move.from.x+dx*.32+nx*move.bend,y:move.from.y+dy*.32+ny*move.bend};
    const b={x:move.from.x+dx*.76+nx*move.bend*.65,y:move.from.y+dy*.76+ny*move.bend*.65};
    return {x:(1-t)**3*move.from.x+3*(1-t)**2*t*a.x+3*(1-t)*t*t*b.x+t**3*move.to.x,y:(1-t)**3*move.from.y+3*(1-t)**2*t*a.y+3*(1-t)*t*t*b.y+t**3*move.to.y};
  }
  return p;
}

export function cursorState(track:CursorTrack,seconds:number){
  const p=cursorPosition(track,seconds);
  const fadeIn=unit((seconds-.08)/.12),fadeOut=unit((track.visibleUntil-seconds)/.15);
  return {...p,opacity:fadeIn*fadeOut,kind:track.kinds[Math.min(track.kinds.length-1,Math.max(0,Math.floor(seconds*track.fps)))]||'default'};
}
