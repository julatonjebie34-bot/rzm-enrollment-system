import { useState } from 'react';
import { ArrowRight, Eye, EyeOff, LockKeyhole, Mail, ShieldCheck, LoaderCircle } from 'lucide-react';
import { db } from './lib';
import './auth.css';

export function AuthScreen({initialError=''}:{initialError?:string}) {
  const [showPassword,setShowPassword]=useState(false);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState(initialError);
  async function submit(event:React.FormEvent<HTMLFormElement>){
    event.preventDefault();setError('');
    if(!db){setError('Please contact the school administrator to configure sign-in.');return;}
    const form=new FormData(event.currentTarget);setBusy(true);
    try {const {error}=await db.auth.signInWithPassword({email:String(form.get('email')||'').trim(),password:String(form.get('password')||'')});if(error)throw error;}
    catch(e){setError(e instanceof Error?e.message:'Unable to sign in. Please try again.');}
    finally{setBusy(false);}
  }
  return <div className="school-auth">
    <div className="school-auth-backdrop" aria-hidden="true"/>
    <div className="school-auth-brand"><img src="/brand/school-logo.jpg" alt="Restituta Z. Medina Elementary School seal" width="84" height="84"/><span><strong>Restituta Z. Medina</strong><span>Elementary School</span></span></div>
    <div className="school-auth-heading"><span className="school-auth-overline">ENROLLMENT MANAGEMENT SYSTEM</span><h1>Welcome back</h1><p>Your school community, connected.</p></div>
    <section className="school-auth-card" aria-labelledby="school-auth-title">
      <div className="school-auth-card-title"><LockKeyhole size={18}/><h2 id="school-auth-title">Faculty & admin login</h2></div>
      <form className="school-auth-form" onSubmit={submit}>
        {error&&<div className="school-auth-feedback is-error" role="alert">{error}</div>}
        <label htmlFor="auth-email">Email address<div className="school-auth-input"><Mail size={18}/><input id="auth-email" name="email" type="email" autoComplete="username" placeholder="Enter your school email" required disabled={busy}/></div></label>
        <label htmlFor="auth-password">Password<div className="school-auth-input"><LockKeyhole size={18}/><input id="auth-password" name="password" type={showPassword?'text':'password'} autoComplete="current-password" placeholder="Enter your password" required disabled={busy}/><button type="button" className="school-auth-reveal" aria-label={showPassword?'Hide password':'Show password'} aria-pressed={showPassword} onClick={()=>setShowPassword(!showPassword)}>{showPassword?<EyeOff size={18}/>:<Eye size={18}/>}</button></div></label>
        <button type="submit" className="school-auth-submit" disabled={busy}>{busy?<><LoaderCircle className="school-auth-spin" size={18}/>Signing in…</>:<>Login<ArrowRight size={18}/></>}</button>
        <p className="staff-access-note"><ShieldCheck size={15}/> Secure access for authorized school staff</p>
      </form>
    </section>
    <p className="school-auth-parent-note">Enrolling a learner?<span>Use the enrollment link provided by the school.</span></p>
    <div className="school-auth-footer"><ShieldCheck size={14}/><span>Restituta Z. Medina Elementary School · Student records</span></div>
  </div>;
}
