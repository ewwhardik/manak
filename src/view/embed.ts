/** A public, script-enabled document intended to be loaded inside another site's iframe. */
export function embedPage(eventSlug: string, parentOrigin: string): string {
  const nonce = crypto.randomUUID().replaceAll("-", "");
  const event = JSON.stringify(eventSlug).replaceAll("<", "\\u003c");
  const parent = JSON.stringify(parentOrigin).replaceAll("<", "\\u003c");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Project gallery</title>
<style>
:root{color-scheme:light dark;font:16px/1.5 system-ui,sans-serif}*{box-sizing:border-box}body{margin:0;color:#182230;background:#fff}
.gallery{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,260px),1fr));gap:12px;padding:12px}
.project{min-width:0;padding:16px;border:1px solid #d7dee8;border-radius:12px;background:#fff;color:#182230}
.project h2{margin:0 0 8px;font-size:1.05rem;line-height:1.3}.project a{color:#155eef;text-decoration:underline;text-underline-offset:2px}
.project p{margin:0;color:#475467;overflow-wrap:anywhere}.track{display:inline-block;margin-top:12px;padding:2px 8px;border-radius:999px;background:#eef4ff;color:#3538cd;font-size:.8rem}
.message{margin:0;padding:16px;color:#475467}.error{color:#b42318}
@media(prefers-color-scheme:dark){body{background:#101828;color:#f2f4f7}.project{background:#1d2939;border-color:#475467;color:#f2f4f7}.project p{color:#d0d5dd}.project a{color:#84caff}.track{background:#3538cd;color:white}.message{color:#d0d5dd}}
</style></head><body><main id="gallery" aria-live="polite"><p class="message">Loading projects…</p></main>
<script nonce="${nonce}">
(function(){
  'use strict';
  var eventSlug=${event}, parentOrigin=${parent};
  var root=document.getElementById('gallery');
  function sendHeight(){
    if(!parentOrigin||window.parent===window)return;
    var height=Math.max(document.documentElement.scrollHeight,document.body.scrollHeight);
    window.parent.postMessage({type:'manak:embed:height',height:height},parentOrigin);
  }
  function escapeHtml(value){return String(value==null?'':value).replace(/[&<>"']/g,function(ch){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch];});}
  window.addEventListener('message',function(event){
    if(event.source!==window.parent||event.origin!==parentOrigin)return;
    if(!event.data||event.data.type!=='manak:embed:ready')return;
    sendHeight();
  });
  if('ResizeObserver' in window){new ResizeObserver(sendHeight).observe(document.documentElement);}
  else{window.addEventListener('resize',sendHeight);}
  var endpoint='/api/events/'+encodeURIComponent(eventSlug)+'/projects';
  fetch(endpoint,{credentials:'omit',headers:{accept:'application/json'}})
    .then(function(response){if(!response.ok)throw new Error('Could not load projects ('+response.status+').');return response.json();})
    .then(function(data){
      var projects=Array.isArray(data.projects)?data.projects:[];
      if(!projects.length){root.innerHTML='<p class="message">No submitted projects yet.</p>';sendHeight();return;}
      root.innerHTML=projects.map(function(project){
        var href='/events/'+encodeURIComponent(eventSlug)+'/projects/'+encodeURIComponent(project.id);
        return '<article class="project"><h2><a href="'+href+'" target="_blank" rel="noopener noreferrer">'+escapeHtml(project.title)+'</a></h2>'+
          (project.summary?'<p>'+escapeHtml(project.summary)+'</p>':'')+
          (project.trackKey?'<span class="track">'+escapeHtml(project.trackKey)+'</span>':'')+'</article>';
      }).join('');
      sendHeight();
    })
    .catch(function(error){root.innerHTML='<p class="message error">'+escapeHtml(error.message||'Could not load projects.')+'</p>';sendHeight();});
})();
</script></body></html>`;
}

/** Script for embedding the gallery as a cross-origin, height-aware iframe. */
export const EMBED_JS = `(function(){
'use strict';
function mount(script){
  var slug=script.getAttribute('data-event')||script.getAttribute('data-manak-event');
  if(!slug)return;
  var api=script.getAttribute('data-api')||script.src;
  var host;
  try{host=new URL(api,window.location.href);if(!/^https?:$/.test(host.protocol))throw new Error();}
  catch(_){var error=document.createElement('p');error.textContent='Invalid Manak embed URL.';script.parentNode.insertBefore(error,script.nextSibling);return;}
  var iframe=document.createElement('iframe');
  iframe.title='Hackathon project gallery';iframe.loading='lazy';iframe.referrerPolicy='no-referrer';
  iframe.setAttribute('sandbox','allow-scripts allow-same-origin allow-popups');
  iframe.style.cssText='display:block;width:100%;height:400px;border:0;border-radius:12px;';
  var url=new URL('/embed/'+encodeURIComponent(slug),host.origin);
  url.searchParams.set('parentOrigin',window.location.origin);
  iframe.src=url.href;
  window.addEventListener('message',function(event){
    if(event.origin!==url.origin||event.source!==iframe.contentWindow)return;
    var data=event.data;
    if(!data||data.type!=='manak:embed:height'||typeof data.height!=='number'||!Number.isFinite(data.height))return;
    iframe.style.height=Math.max(120,Math.min(10000,Math.ceil(data.height)))+'px';
  });
  iframe.addEventListener('load',function(){iframe.contentWindow.postMessage({type:'manak:embed:ready'},url.origin);});
  script.parentNode.insertBefore(iframe,script.nextSibling);
}
var scripts=document.currentScript?[document.currentScript]:Array.prototype.slice.call(document.querySelectorAll('script[data-manak-event],script[data-event]'));
scripts.forEach(mount);
})();`;
