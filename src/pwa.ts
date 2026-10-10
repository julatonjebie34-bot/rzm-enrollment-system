export function registerPWA(){
 if(!import.meta.env.PROD||!('serviceWorker' in navigator))return;
 const register=()=>{void navigator.serviceWorker.register('/sw.js',{updateViaCache:'none'}).catch(error=>console.error('Offline app cache unavailable',error));};
 if(document.readyState==='complete')register();else window.addEventListener('load',register,{once:true});
}
