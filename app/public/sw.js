const CACHE="speech-ai-hub-shell-v27";
self.addEventListener("install",event=>event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(["/manifest.webmanifest","/theme-init.js","/brand-mark.svg","/brand-cover.svg"])).then(()=>self.skipWaiting())));
self.addEventListener("activate",event=>event.waitUntil(Promise.all([self.clients.claim(),caches.keys().then(keys=>Promise.all(keys.filter(key=>key!==CACHE).map(key=>caches.delete(key))))])));
self.addEventListener("fetch",event=>{let requestUrl;try{requestUrl=new URL(event.request.url)}catch{return}if(event.request.method!=="GET"||requestUrl.origin!==location.origin)return;event.respondWith(fetch(event.request).catch(async()=>await caches.match(event.request)??new Response("Network unavailable",{status:503,headers:{"Content-Type":"text/plain; charset=utf-8"}}))) });
self.addEventListener("push",event=>{let data={};try{data=event.data?event.data.json():{}}catch{data={body:event.data?event.data.text():""}}
  const url=typeof data.url==="string"&&data.url.startsWith("/")&&!data.url.startsWith("//")&&data.url!=="/notifications"?data.url:"/";
  event.waitUntil(self.registration.showNotification(data.title||"Speech-AI Hub",{body:data.body||"",tag:data.tag||"hub",renotify:true,icon:"/icon-192.png",badge:"/icon-192.png",data:{url}}));
});
self.addEventListener("notificationclick",event=>{event.notification.close();let url=self.location.origin+"/";try{const next=new URL(event.notification.data?.url||"/",self.location.origin);if(next.origin===self.location.origin)url=next.href}catch{url=self.location.origin+"/"}
  event.waitUntil(self.clients.matchAll({type:"window",includeUncontrolled:true}).then(list=>{for(const client of list){let same=false;try{same=new URL(client.url).origin===self.location.origin}catch{same=false}if(same&&"focus" in client){client.navigate(url);return client.focus()}}return self.clients.openWindow(url)}));
});
