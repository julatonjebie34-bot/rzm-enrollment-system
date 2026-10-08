import { createClient } from '@supabase/supabase-js';
export const authStorageKey = 'sb-yiazkffyceujhtsxvgds-auth-token';
export const configured=!!import.meta.env.VITE_SUPABASE_URL && !!import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
export const db=configured?createClient(import.meta.env.VITE_SUPABASE_URL,import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY):null;
export type Row=Record<string,any>;
export const tables=['school_settings','school_years','grade_levels','sections','subjects','assignments','students','enrollment_links','applications','documents','enrollments','grades','profiles','audit_logs'] as const;
export const finalGrade=(q:(number|null)[])=>q.length===4&&q.every(v=>v!==null)?Math.round(q.reduce<number>((s,v)=>s+(v??0),0)/4):null;
export function csv(rows:Row[]){if(!rows.length)return '';const keys=Object.keys(rows[0]);const quote=(v:any)=>{let text=String(v??'');if(typeof v==='string'&&/^[\s]*[=+@-]/.test(text))text="'"+text;return '"'+text.replace(/"/g,'""')+'"';};return [keys.map(quote).join(','),...rows.map(r=>keys.map(k=>quote(typeof r[k]==='object'?JSON.stringify(r[k]):r[k])).join(','))].join('\r\n');}
export function download(name:string,content:string){const u=URL.createObjectURL(new Blob([content],{type:'text/csv;charset=utf-8'}));const a=document.createElement('a');a.href=u;a.download=name;a.click();URL.revokeObjectURL(u);}
