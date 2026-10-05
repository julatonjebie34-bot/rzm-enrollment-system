import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
Deno.serve(async(req)=>{
 const origin=req.headers.get('origin')||'';const allowed=(Deno.env.get('ALLOWED_ORIGINS')||'').split(',');
 const headers={'Access-Control-Allow-Origin':allowed.includes(origin)?origin:'null','Access-Control-Allow-Headers':'authorization, x-client-info, apikey, content-type','Content-Type':'application/json','Vary':'Origin'};
 const result=(v:unknown,status=200)=>new Response(JSON.stringify(v),{status,headers});
 if(!allowed.includes(origin))return result({error:'Origin not allowed'},403);if(req.method==='OPTIONS')return new Response('ok',{headers});if(req.method!=='POST')return result({error:'Method not allowed'},405);
 const db=createClient(Deno.env.get('SUPABASE_URL')!,Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
 const token=(req.headers.get('authorization')||'').replace(/^Bearer /,'');
 const {data:{user}}=await db.auth.getUser(token);if(!user)return result({error:'Sign in required'},401);
 const {data:profile}=await db.from('profiles').select('role').eq('id',user.id).single();if(profile?.role!=='admin')return result({error:'Admin required'},403);
 try{
  const data=await req.json();if(!['admin','teacher'].includes(data.role)||!String(data.full_name||'').trim())throw Error('Invalid role or name');
  let id=data.id;
  if(id===user.id&&data.role!=='admin')throw Error('You cannot remove your own admin access');
  if(!id){if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)||String(data.password).length<12)throw Error('Use a valid email and a password with at least 12 characters');
   const {data:created,error}=await db.auth.admin.createUser({email:data.email,password:data.password,email_confirm:true});if(error)throw error;id=created.user.id;
   const {error:save}=await db.from('profiles').insert({id,full_name:data.full_name,role:data.role,can_grade:!!data.can_grade});if(save){await db.auth.admin.deleteUser(id);throw save;}
  }else{const {error}=await db.from('profiles').update({full_name:data.full_name,role:data.role,can_grade:!!data.can_grade}).eq('id',id);if(error)throw error;}
  await db.from('audit_logs').insert({actor:user.id,action:'MANAGE_USER',table_name:'profiles',record_id:id});return result({id});
 }catch(e){return result({error:e instanceof Error?e.message:'User operation failed'},400);}
});
