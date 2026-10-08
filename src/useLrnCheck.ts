import {useEffect,useState} from 'react';
export type LrnState='none'|'invalid'|'checking'|'eligible'|'existing_new'|'needs_review'|'duplicate_application'|'pending';
export function useLrnCheck(endpoint:string,lrn:string,learnerType:string,enabled:boolean){const [state,setState]=useState<LrnState>('none');const [connection,setConnection]=useState(0);
 useEffect(()=>{const online=()=>setConnection(v=>v+1);window.addEventListener('online',online);window.addEventListener('offline',online);return()=>{window.removeEventListener('online',online);window.removeEventListener('offline',online)}},[]);
 useEffect(()=>{if(!enabled){setState('none');return;}if(!/^\d{12}$/.test(lrn)){setState('invalid');return;}if(!navigator.onLine){setState('pending');return;}
  setState('checking');const controller=new AbortController();const timeout=setTimeout(()=>controller.abort(),12000);let cancelled=false;const timer=setTimeout(()=>{void fetch(endpoint+'&action=check-lrn',{method:'POST',headers:{'Content-Type':'application/json',apikey:import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY},body:JSON.stringify({lrn,enrollment_type:learnerType}),signal:controller.signal}).then(async response=>{const body=await response.json();if(!response.ok)throw Error(body.errorCode||'Unavailable');if(!cancelled)setState(['eligible','existing_new','needs_review','duplicate_application'].includes(body.status)?body.status:'pending')}).catch(()=>{if(!cancelled)setState('pending')})},650);
  return()=>{cancelled=true;clearTimeout(timer);clearTimeout(timeout);controller.abort()};
 },[endpoint,lrn,learnerType,enabled,connection]);return state;
}
