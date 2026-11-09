import manifest from '../public/captures/v4/manifest.json';
import type {CursorTrack} from './cursor-motion';

type ClipName='compose'|'search'|'todos'|'approval'|'changes';
type NativeClip={file:string;fps:number;frames:number;duration:number;cursor:CursorTrack};
const clips=manifest.clips as unknown as Record<ClipName,NativeClip>;

export function recording(name:ClipName){
  const clip=clips[name];
  if(!clip)throw new Error(`Missing native capture: ${name}. Run npm run capture first.`);
  const kinds=clip.cursor.kinds.map((kind,frame)=>{
    // CSS "auto" resolves to a native I-beam over editable controls. These are
    // the measured settled-input intervals, not additional pointer movement.
    if(name==='compose'&&frame>=127&&frame<=156)return 'text';
    if(name==='search'&&frame>=32&&frame<112)return 'text';
    return kind;
  });
  return {src:clip.file,video:true,cursor:{...clip.cursor,kinds}};
}
