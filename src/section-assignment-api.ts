import {db,Row} from './lib';
import {requireOnline} from './academic-api';
import * as offline from './offline';

export async function placementPreview(application:string|null,enrollment:string|null){
 requireOnline();
 const {data,error}=await db!.rpc('smart_placement_preview',{application,enrollment});
 if(error)throw Error(error.message);return data as Row;
}
export async function confirmPlacement(payload:Row){
 requireOnline();
 if(offline.status.pending)throw Error('Synchronize pending changes before approving or transferring a student.');
 const {data,error}=await db!.rpc('smart_confirm_placement',payload);
 if(error)throw Error(error.message);
 return data;
}
