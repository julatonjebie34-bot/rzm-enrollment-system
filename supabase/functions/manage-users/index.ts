import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
const website='https://rzm-enrollment-system.vercel.app';
Deno.serve(async(req)=>{
 const origin=req.headers.get('origin')||'';
 const allowed=(Deno.env.get('ALLOWED_ORIGINS')||'').split(',').map(s=>s.trim()).filter(Boolean);
 const headers={'Access-Control-Allow-Origin':allowed.includes(origin)?origin:'null','Access-Control-Allow-Headers':'authorization, x-client-info, apikey, content-type','Access-Control-Allow-Methods':'POST, OPTIONS','Content-Type':'application/json','Vary':'Origin'};
 const result=(v:unknown,status=200)=>new Response(JSON.stringify(v),{status,headers});
 if(!allowed.includes(origin))return result({error:'Use the school website address to manage staff accounts.'},403);
 if(req.method==='OPTIONS')return new Response('ok',{headers});
 if(req.method!=='POST')return result({error:'Method not allowed'},405);
 try{
  const db=createClient(Deno.env.get('SUPABASE_URL')!,Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,{auth:{persistSession:false,autoRefreshToken:false}});
  const token=(req.headers.get('authorization')||'').replace(/^Bearer /,'');
  const {data:{user},error:authError}=await db.auth.getUser(token);
  if(authError||!user)return result({error:'Sign in required'},401);
  const {data:profile,error:profileError}=await db.from('profiles').select('*').eq('id',user.id).single();
  if(profileError||!profile?.active)return result({error:'Active staff access required'},403);
  const data=await req.json();const action=data.action||'save';
  const audit=async(action:string,id:string,before:unknown,after:unknown)=>{const {error}=await db.from('audit_logs').insert({actor:user.id,action,table_name:'profiles',record_id:id,before_data:before,after_data:after});if(error)throw Error('Account changed but audit recording failed. Contact the administrator.');};
  if(action==='change-password'){
   if(typeof data.password!=='string'||data.password.length<12||data.password.length>128)throw Error('Use a password of 12–128 characters.');
   // Supabase Auth hashes passwords; never include them in logs or profile rows.
   const {error}=await db.auth.admin.updateUserById(user.id,{password:data.password});if(error)throw error;
   const {error:save}=await db.from('profiles').update({must_change_password:false}).eq('id',user.id);if(save)throw save;
   await audit('PASSWORD_CHANGED',user.id,null,null);return result({id:user.id});
  }
  if(profile.must_change_password)return result({error:'Change your temporary password first.'},403);
  if(action==='profile'){
   const phone=String(data.phone||'').trim();if(phone.length>40)throw Error('Contact number is too long.');
   const {error}=await db.from('profiles').update({phone}).eq('id',user.id);if(error)throw error;
   await audit('PROFILE_CONTACT_CHANGED',user.id,{phone:profile.phone},{phone});return result({id:user.id});
  }
  if(profile.role!=='admin')return result({error:'Administrator access required'},403);
  if(action==='reset'){
   const {data:target,error}=await db.auth.admin.getUserById(String(data.id));if(error||!target.user?.email)throw Error('Staff account not found.');
   const {error:send}=await db.auth.resetPasswordForEmail(target.user.email,{redirectTo:website+'/?reset-password=1'});if(send)throw send;
   await audit('PASSWORD_RESET_EMAIL',String(data.id),null,null);return result({id:data.id});
  }
  if(action==='set-active'){
   if(data.id===user.id)throw Error('You cannot deactivate your own account.');
   if(typeof data.active!=='boolean')throw Error('Choose an account status.');
   const {data:target,error:read}=await db.from('profiles').select('*').eq('id',data.id).single();if(read||!target)throw Error('Staff profile not found.');
   const {error:save}=await db.from('profiles').update({active:data.active}).eq('id',data.id);if(save)throw save;
   const {error:ban}=await db.auth.admin.updateUserById(data.id,{ban_duration:data.active?'none':'876000h'});
   if(ban)throw Error('Profile access changed, but Auth status could not be updated. Retry this action.');
   await audit(data.active?'ACCOUNT_ACTIVATED':'ACCOUNT_DEACTIVATED',data.id,{active:target.active},{active:data.active});return result({id:data.id});
  }
  if(action!=='save')throw Error('Unsupported account operation.');
  const full_name=String(data.full_name||'').trim();if(!['admin','teacher'].includes(data.role)||!full_name||full_name.length>200)throw Error('Use a valid role and name.');
  let id=data.id;const fields:Record<string,unknown>={full_name,role:data.role,can_grade:!!data.can_grade,phone:String(data.phone||'').trim().slice(0,40)};
  if(data.teacher_code){if(!/^[A-Za-z0-9_-]{1,50}$/.test(String(data.teacher_code)))throw Error('Teacher ID may contain letters, numbers, hyphens and underscores.');fields.teacher_code=data.teacher_code;}
  if(id===user.id&&data.role!=='admin')throw Error('You cannot remove your own administrator access.');
  if(!id){
   if(typeof data.email!=='string'||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)||typeof data.password!=='string'||data.password.length<12||data.password.length>128)throw Error('Use a valid email and a temporary password of 12–128 characters.');
   const {data:created,error}=await db.auth.admin.createUser({email:data.email.trim(),password:data.password,email_confirm:true});if(error)throw error;id=created.user.id;
   const {error:save}=await db.from('profiles').insert({id,...fields,active:true,must_change_password:true,teacher_code:fields.teacher_code||(data.role==='teacher'?'T-'+id.replaceAll('-','').toUpperCase():null)});
   if(save){await db.auth.admin.deleteUser(id);throw save;}
  }else{
   const {data:saved,error}=await db.from('profiles').update(fields).eq('id',id).select('id').single();if(error||!saved)throw Error('Unable to update staff account. Check its teacher ID and permissions.');
  }
  await audit('MANAGE_USER',id,null,fields);return result({id});
 }catch(e){return result({error:e instanceof Error?e.message:'Staff operation failed. Please retry.'},400);}
});
