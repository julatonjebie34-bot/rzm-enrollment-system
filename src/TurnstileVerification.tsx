import {useEffect,useRef,useState} from 'react';
import {Language,translations} from './enrollment-i18n';

let loadingScript:Promise<void>|undefined;
function loadTurnstile(){
 if((window as any).turnstile)return Promise.resolve();
 return loadingScript??=new Promise<void>((resolve,reject)=>{
  const script=document.createElement('script');script.src='https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';script.async=true;
  const timer=setTimeout(()=>fail(),20000);
  const fail=()=>{clearTimeout(timer);script.remove();loadingScript=undefined;reject(Error('SCRIPT_LOAD'));};
  script.onerror=fail;script.onload=()=>{clearTimeout(timer);if((window as any).turnstile)resolve();else fail();};document.head.appendChild(script);
 });
}
export function TurnstileVerification({siteKey,language,onToken,resetKey}:{siteKey:string;language:Language;onToken:(token:string)=>void;resetKey:number}){
 const t=translations[language];const container=useRef<HTMLDivElement>(null);const callback=useRef(onToken);callback.current=onToken;
 const [attempt,setAttempt]=useState(0),[code,setCode]=useState(''),[loading,setLoading]=useState(true);
 useEffect(()=>{
  let cancelled=false;let widget:string|undefined;callback.current('');setCode('');setLoading(true);
  if(!siteKey){setCode('CONFIGURATION');setLoading(false);return;}
  void loadTurnstile().then(()=>{
   if(cancelled||!container.current)return;
   const api=(window as any).turnstile;
   api.ready(()=>{
    if(cancelled||!container.current)return;
    try{widget=api.render(container.current,{sitekey:siteKey,action:'enrollment',language:language==='fil'?'auto':'en',size:window.matchMedia('(max-width:420px)').matches?'compact':'flexible',retry:'auto','retry-interval':8000,
     callback:(token:string)=>{if(!cancelled){callback.current(token);setCode('');setLoading(false);}},
     'error-callback':(errorCode:string)=>{if(!cancelled){callback.current('');setCode(String(errorCode));setLoading(false);console.warn('Enrollment verification error:',String(errorCode));}},
     'expired-callback':()=>{if(!cancelled){callback.current('');setCode('EXPIRED');}},
     'timeout-callback':()=>{if(!cancelled){callback.current('');setCode('TIMEOUT');setLoading(false);}}
    });setLoading(false);}catch{if(!cancelled){setCode('RENDER');setLoading(false);}}
   });
  }).catch(()=>{if(!cancelled){setCode('SCRIPT_LOAD');setLoading(false);}});
  return()=>{cancelled=true;if(widget!==undefined)(window as any).turnstile?.remove(widget);callback.current('');};
 },[siteKey,language,attempt,resetKey]);
 const message=code==='110200'?t.verificationDomain:['110100','110110','400020','400070','CONFIGURATION'].includes(code)?t.verificationConfiguration:code==='EXPIRED'?t.verificationExpired:['SCRIPT_LOAD','200500','TIMEOUT'].includes(code)?t.verificationNetwork:t.verificationFailed;
 return <section className="verification-section" aria-label="Cloudflare Turnstile"><div ref={container}/>{loading&&<p role="status">{t.verificationLoading}</p>}{code&&<div className="verification-error" role="alert"><p>{message}</p><small>{t.verificationCode}: {code}</small><button type="button" onClick={()=>setAttempt(n=>n+1)}>{t.verificationRetry}</button></div>}</section>;
}
