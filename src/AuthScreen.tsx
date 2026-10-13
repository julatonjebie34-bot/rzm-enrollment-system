import {updateIndexing} from './seo';
import { useEffect,useState } from 'react';
import { ArrowRight, Eye, EyeOff, LockKeyhole, Mail, ShieldCheck, LoaderCircle } from 'lucide-react';
import { db } from './lib';
import {sendRecoveryCode,verifyRecoveryCode} from './password-recovery';
import './auth.css';

export function AuthScreen({initialError=''}:{initialError?:string}) {
  const [showPassword,setShowPassword]=useState(false);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState(initialError);
  const [email,setEmail]=useState('');
  const [recovering,setRecovering]=useState(false);
  const [notice,setNotice]=useState('');
  const [codeSent,setCodeSent]=useState(false),[code,setCode]=useState(''),[cooldown,setCooldown]=useState(0);
  useEffect(()=>{if(!cooldown)return;const timer=setTimeout(()=>setCooldown(v=>Math.max(0,v-1)),1000);return()=>clearTimeout(timer)},[cooldown]);
  useEffect(()=>{updateIndexing(recovering)},[recovering]);
  function changeMode(recover:boolean){setRecovering(recover);setCodeSent(false);setCode('');setError('');setNotice('');setShowPassword(false);}
  async function sendCode(){
    setBusy(true);setError('');setNotice('');
    try{await sendRecoveryCode(email);setCodeSent(true);setCode('');setCooldown(60);setNotice('If this email belongs to a staff account, a recovery code has been sent. Check your inbox and spam folder.');}
    catch(e){setError(e instanceof Error?e.message:'Unable to send a recovery code.');}
    finally{setBusy(false);}
  }
  async function submit(event:React.FormEvent<HTMLFormElement>){
    event.preventDefault();setError('');setNotice('');
    if(!db){setError('Please contact the school administrator to configure sign-in.');return;}
    if(recovering){
      if(!codeSent){await sendCode();return;}
      setBusy(true);try{await verifyRecoveryCode(email,code)}catch(e){setError(e instanceof Error?e.message:'Unable to verify the code. Check your connection and try again.');}finally{setBusy(false);}
      return;
    }
    const form=new FormData(event.currentTarget);localStorage.setItem('rzm-trusted-device',form.has('trusted')?'true':'false');localStorage.setItem('rzm-offline-until',form.has('trusted')?String(Date.now()+8*60*60*1000):'0');setBusy(true);
    try {const {error}=await db.auth.signInWithPassword({email:String(form.get('email')||'').trim(),password:String(form.get('password')||'')});if(error)throw error;await db.rpc('record_staff_login');}
    catch(e){setError(e instanceof Error?e.message:'Unable to sign in. Please try again.');}
    finally{setBusy(false);}
  }
  return <div className="school-auth">
    <div className="school-auth-backdrop" aria-hidden="true"/>
    <div className="school-auth-brand"><img src="/brand/school-logo.jpg" alt="Restituta Z. Medina Elementary School seal" width="84" height="84"/><span><strong>Restituta Z. Medina</strong><span>Elementary School</span></span></div>
    <div className="school-auth-heading"><span className="school-auth-overline">ENROLLMENT MANAGEMENT SYSTEM</span><h1>Welcome back</h1><p>Your school community, connected.</p></div>
    <section className="school-auth-card" aria-labelledby="school-auth-title">
      <div className="school-auth-card-title">{recovering?<Mail size={18}/>:<LockKeyhole size={18}/>}<h2 id="school-auth-title">{recovering?'Reset your password':'Faculty & admin login'}</h2></div>
      <form className="school-auth-form" onSubmit={submit}>
        <p className="school-auth-intro">{recovering?(codeSent?'Enter the code from your email to choose a new password. Stay on this page; you don’t need to open an email link.':'Enter your staff email and we’ll send you a code to reset your password.'):'Sign in to manage your classes and school records.'}</p>
        {error&&<div className="school-auth-feedback is-error" role="alert">{error}</div>}
        {notice&&<div className="school-auth-feedback is-success" role="status">{notice}</div>}
        <label htmlFor="auth-email">Email address<div className="school-auth-input"><Mail size={18}/><input id="auth-email" name="email" type="email" autoComplete="username" placeholder="Enter your school email" value={email} onChange={e=>setEmail(e.target.value)} required disabled={busy||recovering&&codeSent}/></div></label>
        {recovering&&codeSent&&<label htmlFor="auth-recovery-code">Email recovery code<div className="school-auth-input"><LockKeyhole size={18}/><input id="auth-recovery-code" name="code" type="text" inputMode="numeric" autoComplete="one-time-code" placeholder="Enter your email code" pattern="[0-9]{6,10}" minLength={6} maxLength={10} value={code} onChange={e=>setCode(e.target.value.replace(/\s/g,''))} required disabled={busy} autoFocus/></div></label>}
        {!recovering&&<>
        <label htmlFor="auth-password">Password<div className="school-auth-input"><LockKeyhole size={18}/><input id="auth-password" name="password" type={showPassword?'text':'password'} autoComplete="current-password" placeholder="Enter your password" required disabled={busy}/><button type="button" className="school-auth-reveal" aria-label={showPassword?'Hide password':'Show password'} aria-pressed={showPassword} onClick={()=>setShowPassword(!showPassword)}>{showPassword?<EyeOff size={18}/>:<Eye size={18}/>}</button></div></label>
        <label className="school-auth-trusted"><input type="checkbox" name="trusted"/><span>Allow offline access for 8 hours<small>Use only on your private device.</small></span></label>
        </>}
        <button type="submit" className="school-auth-submit" disabled={busy||recovering&&!codeSent&&cooldown>0}>{busy?<><LoaderCircle className="school-auth-spin" size={18}/>{recovering?(codeSent?'Verifying code…':'Sending code…'):'Signing in…'}</>:<>{recovering?(codeSent?'Verify code':cooldown?`Try again in ${cooldown}s`:'Send recovery code'):'Login'}<ArrowRight size={18}/></>}</button>
        {recovering&&codeSent&&<div className="school-auth-recovery"><button className="school-auth-text-button" type="button" disabled={busy||cooldown>0} onClick={()=>void sendCode()}>{cooldown?`Resend code in ${cooldown}s`:'Resend code'}</button><button className="school-auth-text-button" type="button" disabled={busy} onClick={()=>{setCodeSent(false);setCode('');setError('');setNotice('')}}>Change email</button></div>}
        <div className="school-auth-recovery"><button className="school-auth-text-button" type="button" disabled={busy} onClick={()=>changeMode(!recovering)}>{recovering?'Back to login':'Forgot password?'}</button></div>
        <p className="staff-access-note"><ShieldCheck size={15}/> Secure access for authorized school staff</p>
      </form>
    </section>
    <p className="school-auth-parent-note">Enrolling a learner?<span>Use the enrollment link provided by the school.</span></p>
    <section className="school-public-info" aria-label="About the school enrollment system"><h2>Restituta Z. Medina Elementary School</h2><p>Web-Based Enrollment System</p><p>Online Enrollment is available through school-provided links. Student Information Management and Academic Records Management are available only to authorized school staff.</p></section>
    <div className="school-auth-footer"><ShieldCheck size={14}/><span>Restituta Z. Medina Elementary School · Student records</span></div>
  </div>;
}
