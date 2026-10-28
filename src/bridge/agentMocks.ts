import type {AgentThreadEvent,AgentThreadSnapshot} from "../agents/types"
import type {Unsubscribe} from "./nativeBridge"
const unavailable=()=>new Error("Remote ACP execution needs Still's native SSH bridge. Browser mode will never start a local agent.")
export const unavailableAgentBridge={
 agentLibrary:async():Promise<import('../agents/types').AgentLibrary>=>{throw unavailable()},
 agentFlush:async():Promise<void>=>{},
 agentSaveMetadata:async():Promise<void>=>{throw unavailable()},
 agentSaveWorkspace:async():Promise<void>=>{throw unavailable()},
 agentDeleteSaved:async():Promise<void>=>{throw unavailable()},
 agentMigrate:async():Promise<string[]>=>{throw unavailable()},
 subscribeAgentStorage:async():Promise<Unsubscribe>=>()=>{},
 agentCatalog:async():Promise<import('../agents/types').AgentCatalog>=>{throw unavailable()},
 agentResolveFolder:async():Promise<string>=>{throw unavailable()},
 agentStart:async(_nativeId:string,_localId:string,_agentId:string):Promise<AgentThreadSnapshot>=>{throw unavailable()},
 agentCheck:async():Promise<never>=>{throw unavailable()},
 agentSend:async(_id:string,_message:string):Promise<void>=>{throw unavailable()},
 agentRevert:async():Promise<AgentThreadSnapshot>=>{throw unavailable()},
 agentSetConfig:async(_id:string,_configId:string,_value:string|boolean):Promise<void>=>{throw unavailable()},
 agentRespondPermission:async(_id:string,_requestId:string|number,_optionId:string):Promise<void>=>{throw unavailable()},
 agentCancel:async(_id:string):Promise<void>=>{throw unavailable()},
 agentClose:async(_id:string):Promise<void>=>{throw unavailable()},
 agentRespondInput:async():Promise<void>=>{throw unavailable()},
 agentSnapshot:async(_id:string):Promise<AgentThreadSnapshot>=>{throw unavailable()},
 agentAttach:async():Promise<AgentThreadSnapshot>=>{throw unavailable()},
 subscribeToAgent:async(_id:string,_callback:(event:AgentThreadEvent)=>void):Promise<Unsubscribe>=>{throw unavailable()},
}
