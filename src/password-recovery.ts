import {db} from './lib';
import {staffAction,refreshAcademic,requireOnline} from './academic-api';

export async function sendRecoveryCode(email:string){
 requireOnline();
 const {error}=await db!.auth.resetPasswordForEmail(email.trim(),{redirectTo:'https://rzm-enrollment-system.vercel.app/?reset-password=1'});
 if(error)throw Error('Unable to send a code. Check your connection, wait a minute, and try again. If this continues, contact the school administrator.');
}

export async function verifyRecoveryCode(email:string,code:string){
 requireOnline();
 const token=code.replace(/\s/g,'');
 if(!/^\d{6,10}$/.test(token))throw Error('Enter the numeric code from your email.');
 // Set the recovery route before verification emits an authenticated session.
 const previousUrl=location.pathname+location.search+location.hash;
 const url=new URL(location.href);url.searchParams.set('reset-password','1');
 history.replaceState(null,'',url.pathname+url.search+url.hash);
 localStorage.setItem('rzm-offline-until','0');
 localStorage.setItem('rzm-trusted-device','false');
 try{
  const {data,error}=await db!.auth.verifyOtp({email:email.trim(),token,type:'recovery'});
  if(error||!data.session)throw Error('This code is invalid or expired. Check the latest email or request a new code.');
 }catch(error){history.replaceState(null,'',previousUrl);throw error;}
}

export async function changeStaffPassword(password:string){
 requireOnline();
 if(password.length<12||password.length>128)throw Error('Use a password of 12–128 characters.');
 const {data,error}=await db!.auth.getSession();
 const email=data.session?.user.email;
 if(error||!email)throw Error('Your session expired. Sign in again or request another recovery code.');
 // Do not read cached records with an old session after changing credentials.
 await staffAction({action:'change-password',password},false);
 const signedIn=await db!.auth.signInWithPassword({email,password});
 if(signedIn.error||!signedIn.data.session)throw Error('Your password was changed. Please sign out and log in with your new password to continue.');
 await refreshAcademic();
}
