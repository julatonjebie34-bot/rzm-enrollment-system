// Cache the public app shell only. Authentication, APIs and submitted records use the network.
const CACHE='rzm-static-v1';
const SHELL='/index.html';
const OFFLINE='/offline.html';
const javascript=/^(?:text|application)\/(?:javascript|ecmascript)/i;

function publicFile(request){
 const url=new URL(request.url);
 return request.method==='GET'&&url.origin===self.location.origin&&!url.search&&!request.headers.has('authorization')&&/^\/(?:assets|brand|fonts)\//.test(url.pathname)&&/\.(?:js|css|png|jpe?g|webp|svg|ico|woff2?|ttf)$/i.test(url.pathname);
}
function cacheable(request,response){
 if(!response.ok||response.redirected)return false;
 const path=new URL(request.url).pathname,type=response.headers.get('content-type')||'';
 if(path.endsWith('.js'))return javascript.test(type);
 if(path.endsWith('.css'))return type.startsWith('text/css');
 return /^(?:image\/|font\/|application\/(?:font|octet-stream))/.test(type);
}
self.addEventListener('install',event=>event.waitUntil((async()=>{
 const cache=await caches.open(CACHE);
 await cache.add(OFFLINE);
 const shell=await fetch(SHELL,{cache:'reload',credentials:'omit'});
 if(!shell.ok||!shell.headers.get('content-type')?.includes('text/html'))throw Error('App shell unavailable');
 // Vite writes the current entry scripts and styles into index.html.
 const html=await shell.clone().text();
 const assets=[...new Set([...html.matchAll(/(?:src|href)=["'](\/assets\/[^"']+\.(?:js|css))["']/g)].map(match=>match[1]))];
 await Promise.all(assets.map(async path=>{
  const request=new Request(new URL(path,self.location.origin),{credentials:'omit'});
  const response=await fetch(request);
  if(!cacheable(request,response))throw Error('App asset unavailable');
  await cache.put(request,response);
 }));
 await cache.put(SHELL,shell);
})()));
self.addEventListener('activate',event=>event.waitUntil((async()=>{
 for(const name of await caches.keys())if(name.startsWith('rzm-static-')&&name!==CACHE)await caches.delete(name);
 await self.clients.claim();
})()));
self.addEventListener('fetch',event=>{
 const request=event.request,url=new URL(request.url);
 if(request.method!=='GET'||url.origin!==self.location.origin||request.headers.has('authorization'))return;
 if(request.mode==='navigate'&&['/','/index.html'].includes(url.pathname)){
  event.respondWith((async()=>{
   try{
    const response=await fetch(request);
    if(response.ok&&!response.redirected&&response.headers.get('content-type')?.includes('text/html')){
     const copy=response.clone();event.waitUntil(caches.open(CACHE).then(cache=>cache.put(SHELL,copy)).catch(()=>{}));
    }
    return response;
   }catch{return (await caches.match(SHELL))||(await caches.match(OFFLINE))||Response.error();}
  })());return;
 }
 if(publicFile(request))event.respondWith((async()=>{
  const cached=await caches.match(request);if(cached)return cached;
  const response=await fetch(request);
  if(cacheable(request,response)){const copy=response.clone();event.waitUntil(caches.open(CACHE).then(cache=>cache.put(request,copy)).catch(()=>{}));}
  return response;
 })());
});
