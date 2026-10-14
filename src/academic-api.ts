import {db,Row} from './lib';
import * as offline from './offline';
import {uuid} from './local-db';

export function requireOnline(){if(!navigator.onLine||!db)throw Error('Reconnect to the internet to verify this action with the school database.');}
export async function refreshAcademic(){await offline.pull();}
export async function deleteSchoolYear(year:Row){
 requireOnline();
 if(offline.status.pending)throw Error('Synchronize or resolve pending changes before deleting a school year.');
 const {error}=await db!.rpc('delete_unused_school_year',{target_year:year.id,expected_version:year.sync_version??null});
 if(error)throw Error(error.message);
 try{await refreshAcademic()}catch{throw Error('The school year was deleted, but the display could not refresh. Reconnect and refresh the page.');}
}
export async function saveConfiguration(table:string,row:Row,original?:Row){
 requireOnline();
 const {error}=await db!.rpc('academic_admin_save',{target_table:table,payload:row,expected_version:original?.sync_version??null});
 if(error)throw Error(error.message);await refreshAcademic();
}
export async function gradeAction(action:string,submission:Row,entries:Row,remarks=''){
 requireOnline();
 if(offline.status.pending)throw Error('Synchronize pending changes before submitting or reviewing official grades.');
 const {data,error}=await db!.rpc('grade_workflow',{operation:uuid(),action,assignment:submission.assignment_id,period:submission.period_id,expected_version:submission.sync_version??null,entries,remarks});
 if(error)throw Error(error.message);
 if(data?.status==='conflict'){await refreshAcademic();throw Error('These grades changed on another device. Refresh and review the latest version before trying again.');}
 await refreshAcademic();return data.record;
}
export async function staffAction(body:Row,refresh=true){
 requireOnline();if(location.hostname.endsWith('.vercel.app')&&location.hostname!=='rzm-enrollment-system.vercel.app')throw Error('Open https://rzm-enrollment-system.vercel.app to manage staff accounts. This preview address is not authorized.');const {data,error}=await db!.functions.invoke('manage-users',{body});
 if(error){const response=(error as any).context;if(response instanceof Response){const detail=await response.json().catch(()=>null);if(detail?.error)throw Error(detail.error);}throw Error(error.message);}
 if(data?.error)throw Error(data.error);if(refresh)await refreshAcademic();return data;
}
