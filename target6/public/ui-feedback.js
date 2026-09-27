(() => {
  const clickable='button:not(:disabled), .choice:not(:disabled), .seg:not(:disabled), .nav-item:not(:disabled)';

  function press(el){
    if(!el)return;
    el.classList.add('is-pressed');
    clearTimeout(el._t6PressTimer);
    el._t6PressTimer=setTimeout(()=>el.classList.remove('is-pressed'),140);
  }
  function confirm(el){
    if(!el)return;
    el.classList.add('tap-confirm');
    clearTimeout(el._t6ConfirmTimer);
    el._t6ConfirmTimer=setTimeout(()=>el.classList.remove('tap-confirm'),260);
  }
  function syncAria(){
    $$('.seg').forEach(el=>el.setAttribute('aria-pressed',el.classList.contains('active')?'true':'false'));
    $$('.nav-item').forEach(el=>el.setAttribute('aria-current',el.classList.contains('active')?'page':'false'));
  }

  document.addEventListener('pointerdown',e=>{
    const el=e.target.closest(clickable);
    if(el)press(el);
  },true);

  document.addEventListener('pointerup',e=>{
    const el=e.target.closest(clickable);
    if(el){ el.classList.remove('is-pressed'); confirm(el); setTimeout(syncAria,0); }
  },true);

  document.addEventListener('keydown',e=>{
    if(e.key!=='Enter'&&e.key!==' ')return;
    const el=e.target.closest(clickable);
    if(el)press(el);
  },true);

  document.addEventListener('keyup',e=>{
    if(e.key!=='Enter'&&e.key!==' ')return;
    const el=e.target.closest(clickable);
    if(el){ el.classList.remove('is-pressed'); confirm(el); setTimeout(syncAria,0); }
  },true);

  const mo=new MutationObserver(()=>syncAria());
  mo.observe(document.body,{subtree:true,attributes:true,attributeFilter:['class','disabled']});
  syncAria();
})();