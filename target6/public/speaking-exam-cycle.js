(() => {
  const workspace=()=>$('#speakingWorkspace');
  const phaseNames={
    assistedA:'1/4 · Exame assistido · Section A',
    assistedB:'1/4 · Exame assistido · Section B',
    modelPending:'2/4 · Preparar exemplo AI',
    model:'2/4 · Exemplo de conversa AI',
    vocab:'3/4 · Vocabulário',
    finalA:'4/4 · Exame final · Section A',
    finalB:'4/4 · Exame final · Section B',
    completed:'Ciclo concluído'
  };

  let recorder=null, chunks=[], stream=null, timer=null, finishing=false;
  let audioCtx=null, analyser=null, vadRaf=null, vadHeardVoice=false, vadLastVoiceAt=0, vadStartedAt=0, turnSubmitting=false;
  let cycleRecognition=null, recognitionHeardSpeech=false, recognizedTurnText='', noVoiceFallbackTimer=null, hardTurnTimer=null;

  function blank(){
    return {
      version:2,id:null,active:false,phase:'idle',difficulty:'B1',package:null,
      assistedResults:{},model:null,vocabProgress:{},vocabIndex:0,finalResults:{},
      interactions:{},startedAt:null,completedAt:null
    };
  }

  function C(){
    const old=state.speakingExamCycle;
    if(!old || old.version!==2){
      const fresh=blank();
      if(old?.difficulty)fresh.difficulty=old.difficulty;
      state.speakingExamCycle=fresh;
    }
    return state.speakingExamCycle;
  }

  function persist(){ saveState(); renderCyclePanel(); }
  function phaseText(){ const c=C(); return c.phase==='idle'?'Ainda não iniciado.':(phaseNames[c.phase]||c.phase); }
  function scoreOf(x){ return Number(x?.evaluation?.overall)||0; }
  function scrollWork(){ setTimeout(()=>workspace()?.scrollIntoView({behavior:'smooth',block:'start'}),80); }

  let sprintReturnFn=null;

  function ensureGuidedUi(){
    const c=C();
    if(!c.sprintProgress)c.sprintProgress={};
    if(!Number.isFinite(c.sprintIndex))c.sprintIndex=0;
    if(document.getElementById('cycleGuidedUiStyles'))return c;
    const style=document.createElement('style');
    style.id='cycleGuidedUiStyles';
    style.textContent=
      ".cycle-guide-nav{position:sticky;bottom:10px;z-index:25;margin-top:18px;padding:12px;border:1px solid rgba(127,127,127,.28);border-radius:14px;background:rgba(18,22,31,.96);backdrop-filter:blur(10px);box-shadow:0 10px 30px rgba(0,0,0,.22)}"+
      ".cycle-guide-position{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:10px}.cycle-guide-position>div{padding:10px;border-radius:10px;background:rgba(255,255,255,.05)}"+
      ".cycle-guide-position small{display:block;font-size:.68rem;letter-spacing:.08em;opacity:.68;margin-bottom:4px}.cycle-guide-position strong{display:block;font-size:.88rem}"+
      ".cycle-guide-actions{display:grid;grid-template-columns:1fr 1.2fr 1fr;gap:8px}.cycle-guide-actions button{min-height:44px}.cycle-vocab-sprint-card{max-width:760px;margin:0 auto}"+
      ".cycle-vocab-levels{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-top:14px}.cycle-vocab-levels button{min-height:46px}.cycle-sprint-meta{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;margin:10px 0}"+
      "@media(max-width:720px){.cycle-guide-position{grid-template-columns:1fr}.cycle-guide-actions{grid-template-columns:1fr 1fr}.cycle-guide-actions [data-guide-sprint]{grid-column:1/-1;grid-row:1}.cycle-vocab-levels{grid-template-columns:1fr 1fr}}";
    document.head.appendChild(style);
    return c;
  }

  function attachGuideBar(opts){
    ensureGuidedUi();
    const w=workspace();
    if(!w)return;
    const old=w.querySelector('.cycle-guide-nav');
    if(old)old.remove();
    const nav=document.createElement('div');
    nav.className='cycle-guide-nav';
    const here=opts?.here||phaseText();
    const next=opts?.next||'Continuar o ciclo';
    nav.innerHTML=
      '<div class="cycle-guide-position">'+
        '<div><small>ESTÁS AQUI</small><strong>'+escapeHtml(here)+'</strong></div>'+
        '<div><small>PRÓXIMO PASSO</small><strong>'+escapeHtml(next)+'</strong></div>'+
      '</div>'+
      '<div class="cycle-guide-actions">'+
        '<button class="secondary-btn" data-guide-back>← VOLTAR</button>'+
        '<button class="secondary-btn" data-guide-sprint>VOCAB SPRINT</button>'+
        '<button class="primary-btn" data-guide-next>AVANÇAR →</button>'+
      '</div>';
    w.appendChild(nav);
    const back=nav.querySelector('[data-guide-back]');
    const sprint=nav.querySelector('[data-guide-sprint]');
    const nextBtn=nav.querySelector('[data-guide-next]');
    back.disabled=!opts?.onBack;
    nextBtn.disabled=!opts?.onNext;
    if(opts?.onBack)back.onclick=opts.onBack;
    if(opts?.onNext)nextBtn.onclick=opts.onNext;
    sprint.onclick=()=>openVocabSprint(opts?.onReturn||(()=>resume()));
  }

  function sprintItems(){
    const c=ensureGuidedUi();
    const raw=[
      ...(Array.isArray(c.model?.vocab)?c.model.vocab:[]),
      ...(Array.isArray(c.package?.baselineVocab)?c.package.baselineVocab:[]),
      ...(Array.isArray(c.package?.assisted?.A?.support)?c.package.assisted.A.support:[]),
      ...(Array.isArray(c.package?.assisted?.B?.support)?c.package.assisted.B.support:[])
    ];
    const seen=new Set();
    const out=[];
    for(const item of raw){
      const fr=String(item?.fr||'').trim();
      if(!fr)continue;
      const key=fr.toLocaleLowerCase('fr');
      if(seen.has(key))continue;
      seen.add(key);
      out.push({
        fr,
        pt:String(item?.pt||item?.purposePt||'').trim(),
        pronunciationPt:String(item?.pronunciationPt||'').trim(),
        category:String(item?.category||item?.purposePt||'expressão TEF').trim()
      });
    }
    const rank={unknown:0,recognize:1,use:2,mastered:3};
    return out.sort((a,b)=>(rank[c.sprintProgress[a.fr]]??0)-(rank[c.sprintProgress[b.fr]]??0)).slice(0,20);
  }

  function openVocabSprint(returnFn){
    stopLocalMedia();
    sprintReturnFn=returnFn||(()=>resume());
    const c=ensureGuidedUi();
    const list=sprintItems();
    if(!list.length){
      toast('Ainda não há vocabulário disponível neste ciclo.','error');
      if(sprintReturnFn)sprintReturnFn();
      return;
    }
    c.sprintIndex=Math.max(0,Math.min(c.sprintIndex||0,list.length-1));
    persist();
    renderVocabSprint();
  }

  function returnFromVocabSprint(){
    const fn=sprintReturnFn;
    sprintReturnFn=null;
    if(fn)fn(); else resume();
  }

  function renderVocabSprint(){
    const c=ensureGuidedUi(),list=sprintItems(),w=workspace();
    if(!list.length){returnFromVocabSprint();return;}
    c.sprintIndex=Math.max(0,Math.min(c.sprintIndex||0,list.length-1));
    const i=c.sprintIndex,x=list[i],status=c.sprintProgress[x.fr]||'';
    const counts={unknown:0,recognize:0,use:0,mastered:0};
    for(const item of list){
      const s=c.sprintProgress[item.fr];
      if(counts[s]!==undefined)counts[s]++;
    }
    w.className='panel exercise-panel';
    w.innerHTML=
      '<div class="cycle-stage-head"><div><div class="cycle-stage-kicker">VOCAB SPRINT · TEF</div><h3>Treino rápido sem perderes o ponto do exame</h3></div><span class="badge">'+(i+1)+'/'+list.length+'</span></div>'+
      '<div class="cycle-sprint-meta"><span>Não sei: <strong>'+counts.unknown+'</strong></span><span>Reconheço: <strong>'+counts.recognize+'</strong></span><span>Consigo usar: <strong>'+counts.use+'</strong></span><span>Dominadas: <strong>'+counts.mastered+'</strong></span></div>'+
      '<div class="vocab-card-large cycle-vocab-sprint-card">'+
        '<span class="vocab-category">'+escapeHtml(x.category||'expressão TEF')+'</span>'+
        '<div class="vocab-fr" lang="fr">'+escapeHtml(x.fr)+'</div>'+
        '<div class="hero-actions"><button id="cycleSprintAudio" class="secondary-btn">▶ Ouvir</button><button id="cycleSprintMeaning" class="secondary-btn">Mostrar significado</button></div>'+
        '<div id="cycleSprintMeaningBox" class="vocab-help hidden">'+
          (x.pronunciationPt?'<div class="pronunciation-cue"><b>Lê assim:</b> '+escapeHtml(x.pronunciationPt)+'</div>':'')+
          '<p>'+escapeHtml(x.pt||'Usa esta expressão numa resposta TEF e tenta explicar o significado pelas palavras à volta.')+'</p>'+
        '</div>'+
        '<div class="cycle-vocab-levels">'+
          '<button class="danger-ghost" data-sprint-level="unknown">NÃO SEI</button>'+
          '<button class="secondary-btn" data-sprint-level="recognize">RECONHEÇO</button>'+
          '<button class="secondary-btn" data-sprint-level="use">CONSIGO USAR</button>'+
          '<button class="primary-btn" data-sprint-level="mastered">DOMINADA</button>'+
        '</div>'+
        '<div class="vocab-nav"><button id="cycleSprintPrev" class="secondary-btn" '+(i===0?'disabled':'')+'>← Anterior</button><button id="cycleSprintReturn" class="primary-btn">VOLTAR AO TEF</button><button id="cycleSprintNext" class="secondary-btn" '+(i===list.length-1?'disabled':'')+'>Seguinte →</button></div>'+
      '</div>';
    document.getElementById('cycleSprintAudio').onclick=()=>playStudyPhrase(x.fr,'neutral',document.getElementById('cycleSprintAudio'));
    document.getElementById('cycleSprintMeaning').onclick=()=>{
      const box=document.getElementById('cycleSprintMeaningBox');
      const hidden=box.classList.toggle('hidden');
      document.getElementById('cycleSprintMeaning').textContent=hidden?'Mostrar significado':'Ocultar significado';
    };
    document.getElementById('cycleSprintPrev').onclick=()=>{c.sprintIndex--;persist();renderVocabSprint();};
    document.getElementById('cycleSprintNext').onclick=()=>{c.sprintIndex++;persist();renderVocabSprint();};
    document.getElementById('cycleSprintReturn').onclick=returnFromVocabSprint;
    w.querySelectorAll('[data-sprint-level]').forEach(btn=>{
      btn.onclick=()=>{
        c.sprintProgress[x.fr]=btn.dataset.sprintLevel;
        if(i<list.length-1)c.sprintIndex++;
        persist();
        renderVocabSprint();
      };
    });
    const active=w.querySelector('[data-sprint-level="'+status+'"]');
    if(active)active.setAttribute('aria-current','true');
    scrollWork();
  }

  function renderCyclePanel(){
    const c=C(),status=$('#examCycleStatus'),start=$('#startExamCycle'),reset=$('#resetExamCycle'),sel=$('#cycleDifficulty'),badge=$('#examCycleBadge');
    if(!status||!start)return;
    status.textContent=c.phase==='completed'?'Concluído. Podes rever ou iniciar um novo ciclo.':c.active?`Em curso: ${phaseText()}`:'Ainda não iniciado.';
    start.textContent=c.active?'RETOMAR CICLO':c.phase==='completed'?'VER RESULTADO / NOVO CICLO':'INICIAR CICLO COMPLETO';
    if(sel){ sel.value=c.difficulty||'B1'; sel.disabled=Boolean(c.active); }
    if(reset)reset.classList.toggle('hidden',!(c.active||c.phase==='completed'));
    if(badge)badge.textContent=c.phase==='completed'?'CONCLUÍDO':c.active?phaseText().split(' · ')[0]:'4 PASSOS';
  }

  async function startNew(){
    const c=blank();
    c.id='cycle_'+Date.now();
    c.active=true;
    c.phase='assistedA';
    c.difficulty=$('#cycleDifficulty')?.value||'B1';
    c.startedAt=new Date().toISOString();
    state.speakingExamCycle=c;
    persist();
    const btn=$('#startExamCycle');
    setBusy(btn,true,'A criar ciclo…');
    const w=workspace();
    if(w){
      w.className='panel exercise-panel sim-loading';
      w.innerHTML=`<span class="loader"></span><strong>A preparar ciclo TEF interativo · ${escapeHtml(c.difficulty)}</strong><small>Vou criar treino assistido e exame final com cenários diferentes.</small>`;
    }
    try{
      const {cycle}=await api('/api/generate-speaking-cycle',{difficulty:c.difficulty});
      C().package=cycle;
      persist();
      renderInteractive('A',true,true);
    }catch(e){
      C().active=false; C().phase='idle'; persist();
      if(w)w.innerHTML=`<div class="feedback feedback-retry"><strong>Não consegui criar o ciclo.</strong><p>${escapeHtml(friendlyError(e))}</p></div>`;
      toast(friendlyError(e),'error');
    }finally{
      setBusy(btn,false);
    }
  }

  function resetCycle(){
    stopLocalMedia();
    state.speakingExamCycle=blank();
    persist();
    const w=workspace();
    if(w){
      w.className='panel exercise-panel empty-state';
      w.innerHTML='<div class="empty-icon">→</div><h3>Ciclo reiniciado.</h3><p>Escolhe a dificuldade e inicia novamente.</p>';
    }
  }

  function taskFor(section,assisted){
    const c=C();
    const src=assisted?c.package?.assisted?.[section]:c.package?.final?.[section];
    if(!src)return null;
    return {...src,assisted,noHelp:!assisted,_cycleId:c.id,_cycleStage:(assisted?'assisted':'final')+section};
  }

  function keyFor(section,assisted){ return (assisted?'assisted':'final')+section; }
  function maxSeconds(section){ return section==='A'?300:600; }

  function ensureRuntime(section,assisted,forceNew=false){
    const c=C(),key=keyFor(section,assisted),max=maxSeconds(section);
    if(forceNew || !c.interactions[key]){
      c.interactions[key]={
        section,assisted,conversation:[],candidateTurns:[],startedAt:Date.now(),
        endAt:Date.now()+max*1000,maxSeconds:max,completed:false,evaluation:null
      };
    }else if(!c.interactions[key].completed && (!c.interactions[key].endAt || c.interactions[key].endAt<Date.now())){
      c.interactions[key].endAt=Date.now()+max*1000;
      c.interactions[key].startedAt=Date.now();
    }
    return c.interactions[key];
  }

  function stopVAD(){
    if(vadRaf){ cancelAnimationFrame(vadRaf); vadRaf=null; }
    if(noVoiceFallbackTimer){ clearTimeout(noVoiceFallbackTimer); noVoiceFallbackTimer=null; }
    if(hardTurnTimer){ clearTimeout(hardTurnTimer); hardTurnTimer=null; }
    if(cycleRecognition){ try{cycleRecognition.onend=null;cycleRecognition.stop();}catch{} cycleRecognition=null; }
    recognitionHeardSpeech=false;
    if(audioCtx){ try{audioCtx.close();}catch{} }
    audioCtx=null; analyser=null; vadHeardVoice=false; vadLastVoiceAt=0; vadStartedAt=0;
  }

  function stopLocalMedia(){
    clearInterval(timer); timer=null;
    stopVAD();
    if(recorder?.state==='recording'){ try{recorder.stop();}catch{} }
    if(stream){ try{stream.getTracks().forEach(t=>t.stop());}catch{} }
    recorder=null; stream=null; chunks=[];
  }

  function startSpeechEndDetector(section,assisted){
    const SR=window.SpeechRecognition||window.webkitSpeechRecognition;
    if(!SR)return;
    try{
      cycleRecognition=new SR();
      cycleRecognition.lang='fr-FR';
      cycleRecognition.interimResults=true;
      cycleRecognition.continuous=false;
      recognitionHeardSpeech=false;
      recognizedTurnText='';
      cycleRecognition.onresult=e=>{
        let finalText='',interim='';
        for(let i=0;i<e.results.length;i++){
          const t=String(e.results[i][0]?.transcript||'').trim();
          if(!t)continue;
          recognitionHeardSpeech=true;
          if(e.results[i].isFinal)finalText+=(finalText?' ':'')+t;
          else interim+=(interim?' ':'')+t;
        }
        if(finalText)recognizedTurnText=(recognizedTurnText+' '+finalText).trim();
        const heard=(recognizedTurnText||interim).trim();
        const st=$('#cycleTurnStatus');
        if(st && heard)st.textContent='Ouvi: “'+heard+'” — termina a frase e faz uma pequena pausa.';
      };
      const notePause=()=>{
        const st=$('#cycleTurnStatus');
        if(st && recorder?.state==='recording')st.textContent=assisted
          ? 'Pausa detetada — continua quando quiseres. Só envio quando carregares TERMINEI — ENVIAR RESPOSTA.'
          : 'Pausa detetada — podes continuar. Espero cerca de 4 segundos antes de enviar.';
      };
      cycleRecognition.onspeechend=notePause;
      cycleRecognition.onend=notePause;
      cycleRecognition.onerror=()=>{};
      cycleRecognition.start();
    }catch{}
  }

  function startVAD(section,assisted){
    stopVAD();
    startSpeechEndDetector(section,assisted);
    const AudioCtx=window.AudioContext||window.webkitAudioContext;
    if(!AudioCtx || !stream || !recorder)return;
    try{
      audioCtx=new AudioCtx();
      if(audioCtx.state==='suspended')audioCtx.resume().catch(()=>{});
      const source=audioCtx.createMediaStreamSource(stream);
      analyser=audioCtx.createAnalyser();
      analyser.fftSize=1024;
      analyser.smoothingTimeConstant=.08;
      source.connect(analyser);
      const data=new Uint8Array(analyser.fftSize);
      vadStartedAt=performance.now();
      vadLastVoiceAt=vadStartedAt;
      vadHeardVoice=false;
      let hotFrames=0;
      const silenceMs=assisted?999999:4000;
      const minTurnMs=250;
      const threshold=.006;

      const loop=(now)=>{
        if(!recorder || recorder.state!=='recording'){ stopVAD(); return; }
        analyser.getByteTimeDomainData(data);
        let sum=0;
        for(let i=0;i<data.length;i++){ const v=(data[i]-128)/128; sum+=v*v; }
        const rms=Math.sqrt(sum/data.length);
        if(rms>threshold){
          hotFrames++;
          if(hotFrames>=2){ vadHeardVoice=true; vadLastVoiceAt=now; }
        }else{
          hotFrames=Math.max(0,hotFrames-1);
        }
        if(!assisted && vadHeardVoice && now-vadStartedAt>minTurnMs && now-vadLastVoiceAt>silenceMs){
          stopVAD();
          stopTurn(section,assisted,true);
          return;
        }
        vadRaf=requestAnimationFrame(loop);
      };
      vadRaf=requestAnimationFrame(loop);

      // Voice activity, not SpeechRecognition end events, decides when the learner has actually finished.
    }catch{
      // The independent hardTurnTimer in startTurn still guarantees that recording cannot hang forever.
    }
  }

  function remaining(rt){
    return Math.max(0,Math.ceil((rt.endAt-Date.now())/1000));
  }

  function startClock(section,assisted){
    clearInterval(timer);
    const rt=ensureRuntime(section,assisted);
    const tick=()=>{
      const el=$('#cycleClock');
      const left=remaining(rt);
      if(el)el.textContent=formatTime(left);
      if(left<=0){
        clearInterval(timer); timer=null;
        const st=$('#cycleTurnStatus'); if(st)st.textContent='Tempo terminado.';
        if(rt.candidateTurns.length && !rt.completed)finishInteractive(section,assisted,true);
      }
    };
    tick();
    timer=setInterval(tick,1000);
  }

  function supportCard(task){
    const support=Array.isArray(task.support)?task.support:[];
    return `<div class="assisted-help-card">
      <h4>AJUDA PT DISPONÍVEL</h4>
      <div class="assisted-translation"><strong>O que a consigne quer dizer:</strong>\n${escapeHtml(task.promptPt||'')}</div>
      <div class="support-phrase-list">${support.map((x,i)=>`<div class="support-phrase"><button class="mini-audio cycle-support-audio" data-i="${i}">🔊</button><div><span class="support-purpose">${escapeHtml(x.purposePt||'Frase útil')}</span><strong lang="fr">${escapeHtml(x.fr||'')}</strong><small class="pronunciation-cue"><b>Lê assim:</b> ${escapeHtml(x.pronunciationPt||'')}</small><small>${escapeHtml(x.pt||'')}</small></div></div>`).join('')}</div>
    </div>`;
  }

  function renderConversation(rt,assisted){
    const log=$('#cycleConversation');
    if(!log)return;
    if(!rt.conversation.length){
      log.innerHTML='<div class="conversation-empty">'+(assisted?'Começa a falar em francês. O AI examinador responderá como no role-play.':'A interação começa quando enviares o primeiro turno.')+'</div>';
      return;
    }
    if(!assisted){
      log.innerHTML=rt.conversation.map((x,i)=>{
        const n=Math.floor(i/2)+1;
        return x.role==='candidate'
          ? `<div class="bubble candidate"><span>Tu · turno ${n}</span>Resposta enviada</div>`
          : `<div class="bubble examiner"><span>Examinador AI</span>Resposta áudio reproduzida</div>`;
      }).join('');
      log.scrollTop=log.scrollHeight;
      return;
    }
    log.innerHTML=rt.conversation.map((x,i)=>{
      if(x.role==='candidate')return `<div class="bubble candidate"><span>Tu</span>${escapeHtml(x.text||'')}</div>`;
      const opts=Array.isArray(x.responseOptions)?x.responseOptions:[];
      return `<div class="bubble examiner"><span>Examinador AI</span>${escapeHtml(x.text||'')}
        ${x.replyPt?`<div class="assisted-help-card"><strong>Em português:</strong><p>${escapeHtml(x.replyPt)}</p>${x.helpPt?`<p><strong>O que fazer agora:</strong> ${escapeHtml(x.helpPt)}</p>`:''}
        ${opts.length?`<div class="support-phrase-list">${opts.map((o,j)=>`<div class="support-phrase"><button class="mini-audio cycle-turn-option-audio" data-ci="${i}" data-oi="${j}">🔊</button><div><span class="support-purpose">${escapeHtml(o.purposePt||'Possível resposta')}</span><strong lang="fr">${escapeHtml(o.fr||'')}</strong><small class="pronunciation-cue"><b>Lê assim:</b> ${escapeHtml(o.pronunciationPt||'')}</small><small>${escapeHtml(o.pt||'')}</small></div></div>`).join('')}</div>`:''}</div>`:''}
      </div>`;
    }).join('');
    $$('.cycle-turn-option-audio',log).forEach(b=>{
      const item=rt.conversation[Number(b.dataset.ci)]?.responseOptions?.[Number(b.dataset.oi)];
      if(item)b.onclick=()=>playStudyPhrase(item.fr,'neutral',b);
    });
    log.scrollTop=log.scrollHeight;
  }

  function wireSupportAudio(task){
    const support=Array.isArray(task.support)?task.support:[];
    $$('.cycle-support-audio',workspace()).forEach(b=>{
      const x=support[Number(b.dataset.i)];
      if(x)b.onclick=()=>playStudyPhrase(x.fr,'neutral',b);
    });
  }

  function renderInteractive(section,assisted,forceNew=false){
    stopLocalMedia();
    finishing=false;
    const c=C(),task=taskFor(section,assisted);
    if(!task){ toast('A tarefa desta secção não está disponível.','error'); return; }
    const rt=ensureRuntime(section,assisted,forceNew);
    c.active=true;
    c.phase=(assisted?'assisted':'final')+section;
    persist();

    const w=workspace();
    w.className='panel exercise-panel';
    const modeTitle=assisted?'EXAME ASSISTIDO · AI EXAMINADOR':'EXAME FINAL · AI EXAMINADOR';
    const note=assisted
      ? '<div class="cycle-banner"><strong>AJUDA DISPONÍVEL</strong><span>Tu falas → o AI examinador responde em francês → tu continuas. Podes consultar tradução, frases e sugestões.</span></div>'
      : '<div class="exam-no-help-banner"><strong>SEM AJUDA</strong><span>Tu falas → o AI examinador responde por voz → tu reages. Sem tradução, frases-modelo, legendas ou pronúncia.</span></div>';

    w.innerHTML=`
      <div class="mock-head"><div><div class="small-label">${modeTitle}</div><h3>Section ${section} · ${escapeHtml(task.title||'')}</h3></div><div id="cycleClock" class="mock-clock">${formatTime(remaining(rt))}</div></div>
      ${note}
      <div class="task-card"><h4>Consigne</h4><div class="task-prompt">${escapeHtml(task.promptFr||'')}</div>${assisted&&task.prepTipPt?`<p><small><strong>Dica PT:</strong> ${escapeHtml(task.prepTipPt)}</small></p>`:''}</div>
      ${assisted?supportCard(task):''}
      <div id="cycleConversation" class="conversation-log"></div>
      <div class="recording-controls">
        <button id="cycleTurnStart" class="record-btn">● Falar / Responder</button>
        <button id="cycleTurnStop" class="stop-btn" disabled>${assisted?'■ TERMINEI — ENVIAR RESPOSTA':'■ Enviar agora'}</button>
        <button id="cycleFinishSection" class="secondary-btn">Terminar secção e avaliar</button>
      </div>
      <div id="cycleTurnStatus" class="small-label">${assisted?'Carrega Falar / Responder e fala sem pressa. No treino assistido NÃO envio sozinho: quando acabares toda a resposta, carrega TERMINEI — ENVIAR RESPOSTA.':'Modo exame: fala normalmente. O sistema espera cerca de 4 s de silêncio antes de enviar, para não cortar a tua resposta.'}</div>
      <div id="cycleSectionFeedback"></div>`;

    renderConversation(rt,assisted);
    if(assisted)wireSupportAudio(task);
    $('#cycleTurnStart').onclick=()=>startTurn(section,assisted);
    $('#cycleTurnStop').onclick=()=>stopTurn(section,assisted);
    $('#cycleFinishSection').onclick=()=>finishInteractive(section,assisted,false);
    startClock(section,assisted);
    const interactiveBack=assisted
      ? (section==='B'&&C().assistedResults.A?.evaluation?()=>renderSectionResult('A',true,C().assistedResults.A.evaluation):null)
      : (section==='A'?()=>renderVocab():(C().finalResults.A?.evaluation?()=>renderSectionResult('A',false,C().finalResults.A.evaluation):()=>renderVocab()));
    attachGuideBar({
      here:(assisted?'Passo 1/4 · TEF com ajuda':'Passo 4/4 · TEF sem ajuda')+' · Section '+section,
      next:section==='A'?'Section B':(assisted?'Passo 2/4 · Exemplo AI':'Resultado final'),
      onBack:interactiveBack,
      onNext:()=>finishInteractive(section,assisted,false),
      onReturn:()=>renderInteractive(section,assisted,false)
    });
    scrollWork();
  }

  async function startTurn(section,assisted,auto=false){
    if(turnSubmitting)return;
    if(!navigator.mediaDevices?.getUserMedia){ toast('Microfone indisponível neste browser.','error'); return; }
    try{
      stream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true}});
      const mime=MediaRecorder.isTypeSupported('audio/webm;codecs=opus')?'audio/webm;codecs=opus':'audio/webm';
      recorder=new MediaRecorder(stream,{mimeType:mime});
      chunks=[];
      recorder.ondataavailable=e=>{ if(e.data.size)chunks.push(e.data); };
      recorder.start(300);
      $('#cycleTurnStart').disabled=true;
      $('#cycleTurnStart').classList.add('live');
      $('#cycleTurnStart').textContent='● A ouvir-te…';
      $('#cycleTurnStop').disabled=false;
      $('#cycleTurnStatus').textContent=assisted
        ? 'A ouvir-te… fala à vontade. Só envio quando carregares TERMINEI — ENVIAR RESPOSTA.'
        : (auto?'Microfone aberto. Responde agora…':'A ouvir-te… fala normalmente; podes fazer pequenas pausas para pensar.');
      startVAD(section,assisted);
      hardTurnTimer=setTimeout(()=>{
        if(recorder?.state==='recording' && !turnSubmitting){
          const st=$('#cycleTurnStatus');
          if(st)st.textContent='A fechar este turno para o examinador responder…';
          stopTurn(section,assisted,true,recognizedTurnText);
        }
      },assisted?120000:60000);
    }catch(e){
      toast('Não consegui abrir o microfone: '+e.message,'error');
    }
  }

  async function stopTurn(section,assisted,auto=false,recognizedText=''){
    if(turnSubmitting)return;
    if(!recorder || recorder.state!=='recording')return;
    turnSubmitting=true;
    if(hardTurnTimer){ clearTimeout(hardTurnTimer); hardTurnTimer=null; }
    if(noVoiceFallbackTimer){ clearTimeout(noVoiceFallbackTimer); noVoiceFallbackTimer=null; }
    const speechText=String(recognizedText||recognizedTurnText||'').trim();
    stopVAD();
    $('#cycleTurnStop').disabled=true;
    $('#cycleTurnStatus').textContent=auto?'Pausa detetada — a enviar o teu turno…':'A enviar o teu turno…';
    const dataUrl=await new Promise(resolve=>{
      recorder.onstop=()=>{
        const blob=new Blob(chunks,{type:recorder.mimeType});
        const reader=new FileReader();
        reader.onload=()=>resolve(reader.result);
        reader.readAsDataURL(blob);
        if(stream)stream.getTracks().forEach(t=>t.stop());
        stream=null;
      };
      recorder.stop();
    });

    const rt=ensureRuntime(section,assisted),task=taskFor(section,assisted);
    try{
      let candidateText='';
      try{
        const {transcript}=await api('/api/transcribe',{audioDataUrl:dataUrl});
        candidateText=String(transcript||'').trim();
      }catch{}
      if(!candidateText)candidateText=speechText;
      if(!candidateText)throw new Error('A transcrição ficou vazia. Repete o turno.');

      rt.candidateTurns.push(candidateText);
      rt.conversation.push({role:'candidate',text:candidateText});
      persist();
      renderConversation(rt,assisted);

      $('#cycleTurnStatus').textContent='O examinador AI está a responder…';
      const history=rt.conversation.slice(-12).map(x=>({role:x.role,text:x.text}));
      const {turn}=await api('/api/examiner-turn',{section,task,history,candidateText,assisted});
      rt.conversation.push({
        role:'examiner',
        text:turn.replyFr,
        replyPt:assisted?turn.replyPt:'',
        helpPt:assisted?turn.helpPt:'',
        responseOptions:assisted?(turn.responseOptions||[]):[]
      });
      persist();
      renderConversation(rt,assisted);

      $('#cycleTurnStatus').textContent='Examinador a falar…';
      await playStudyPhrase(turn.replyFr,'man');
      if(assisted){
        $('#cycleTurnStatus').textContent='Tua vez. Consulta a ajuda se precisares, carrega Falar / Responder e só depois de terminares tudo carrega TERMINEI — ENVIAR RESPOSTA.';
      }else{
        $('#cycleTurnStatus').textContent='Tua vez — a abrir o microfone…';
        setTimeout(()=>startTurn(section,assisted,true),650);
      }
    }catch(e){
      toast(friendlyError(e),'error');
      $('#cycleTurnStatus').textContent='Falha neste turno. Podes gravar novamente.';
    }finally{
      turnSubmitting=false;
      const start=$('#cycleTurnStart');
      if(start){
        start.disabled=false;
        start.classList.remove('live');
        start.textContent='● Falar / Responder';
      }
    }
  }

  async function finishInteractive(section,assisted,fromTimer=false){
    if(finishing)return;
    const rt=ensureRuntime(section,assisted),task=taskFor(section,assisted);
    if(!rt.candidateTurns.length){
      toast('Preciso de pelo menos um turno falado antes de avaliar.','error');
      if(fromTimer){
        rt.endAt=Date.now()+60*1000;
        startClock(section,assisted);
      }
      return;
    }
    finishing=true;
    clearInterval(timer); timer=null;
    stopLocalMedia();
    const w=workspace();
    w.innerHTML=`<div class="panel-head"><h3>A avaliar Section ${section}</h3><span class="loader"></span></div><p>${assisted?'Avaliação de treino assistido. Não conta para a readiness.':'Avaliação da prova sem ajuda.'}</p>`;
    const transcript=rt.candidateTurns.join('\n');
    const usedSeconds=Math.max(1,Math.min(rt.maxSeconds,Math.round((Date.now()-rt.startedAt)/1000)));
    try{
      let evaluation,raters=[];
      if(assisted){
        const r=await api('/api/evaluate-speaking',{section,task,transcript,durationSeconds:usedSeconds});
        evaluation=r.evaluation;
      }else{
        const r=await api('/api/evaluate-speaking-multi',{section,task,transcript,durationSeconds:usedSeconds});
        evaluation=r.evaluation; raters=r.raters||[];
      }

      rt.completed=true; rt.evaluation=evaluation; rt.raters=raters; rt.durationSeconds=usedSeconds;
      const payload={evaluation,raters,transcript,conversation:rt.conversation,durationSeconds:usedSeconds,at:new Date().toISOString()};
      const c=C();
      if(assisted)c.assistedResults[section]=payload; else c.finalResults[section]=payload;
      state.speakingAttempts.push({
        section,overall:evaluation.overall,readinessBand:evaluation.readinessBand,criteria:evaluation.criteria,
        at:new Date().toISOString(),assisted,cycleStage:(assisted?'assisted':'final')+section
      });
      logHistory(assisted?'Speaking assistido':'Speaking final',`Section ${section}`,`${evaluation.overall}/100 · ${bandLabel(evaluation.readinessBand)}`);
      persist();
      renderSectionResult(section,assisted,evaluation);
    }catch(e){
      w.innerHTML=`<div class="feedback feedback-retry"><strong>Falha na avaliação.</strong><p>${escapeHtml(friendlyError(e))}</p><button id="cycleRetryEval" class="primary-btn">Tentar novamente</button></div>`;
      $('#cycleRetryEval').onclick=()=>{finishing=false;finishInteractive(section,assisted,false);};
    }finally{
      finishing=false;
    }
  }

  function renderSectionResult(section,assisted,evaluation){
    const c=C(),w=workspace();
    w.className='panel exercise-panel';
    w.innerHTML='<div id="speakingFeedback"></div><div id="cycleAfterEval"></div>';
    renderSpeakingEvaluation(evaluation,w);
    const holder=$('#cycleAfterEval');
    let label='';
    if(assisted && section==='A')label='CONTINUAR PARA SECTION B COM AI EXAMINADOR';
    if(assisted && section==='B')label='VER COMO UMA BOA CONVERSA PODIA TER ACONTECIDO';
    if(!assisted && section==='A')label='CONTINUAR PARA SECTION B SEM AJUDA';
    if(!assisted && section==='B')label='VER RESULTADO FINAL';
    holder.innerHTML=`<div class="cycle-next-box"><div><strong>${escapeHtml(label)}</strong><small>${assisted?'Continua o treino interativo.':'Mantém o modo exame sem ajuda.'}</small></div><button id="cycleEvalNext" class="primary-btn">${escapeHtml(label)}</button></div>`;
    const advanceFromResult=()=>{
      if(assisted && section==='A')renderInteractive('B',true,true);
      else if(assisted && section==='B')generateModel();
      else if(!assisted && section==='A')renderInteractive('B',false,true);
      else finishCycle();
    };
    $('#cycleEvalNext').onclick=advanceFromResult;
    if(assisted)c.phase=section==='A'?'assistedB':'modelPending';
    else c.phase=section==='A'?'finalB':'completed';
    persist();
    const resultBack=assisted
      ? (section==='A'?null:(c.assistedResults.A?.evaluation?()=>renderSectionResult('A',true,c.assistedResults.A.evaluation):null))
      : (section==='A'?()=>renderVocab():(c.finalResults.A?.evaluation?()=>renderSectionResult('A',false,c.finalResults.A.evaluation):()=>renderVocab()));
    attachGuideBar({
      here:(assisted?'Passo 1/4 · Resultado assistido':'Passo 4/4 · Resultado sem ajuda')+' · Section '+section,
      next:section==='A'?'Section B':(assisted?'Passo 2/4 · Exemplo AI':'Resumo final'),
      onBack:resultBack,
      onNext:advanceFromResult,
      onReturn:()=>renderSectionResult(section,assisted,evaluation)
    });
    scrollWork();
  }

  async function generateModel(){
    const c=C();
    c.phase='modelPending'; persist();
    const w=workspace();
    w.className='panel exercise-panel sim-loading';
    w.innerHTML='<span class="loader"></span><strong>A criar exemplo de conversa AI</strong><small>Vou usar os teus turnos reais para mostrar como uma boa interação poderia ter acontecido.</small>';
    try{
      const {model}=await api('/api/speaking-cycle-model',{assisted:c.package.assisted,results:c.assistedResults});
      c.model=model; c.phase='model'; c.active=true;
      addVocab((model.vocab||[]).map(x=>({fr:x.fr,pt:x.pt,pronunciationPt:x.pronunciationPt,source:'speaking-argumentation'})));
      persist();
      renderModel();
    }catch(e){
      w.innerHTML=`<div class="feedback feedback-retry"><strong>Falha a criar o exemplo.</strong><p>${escapeHtml(friendlyError(e))}</p><button id="retryCycleModel" class="primary-btn">Tentar novamente</button></div>`;
      $('#retryCycleModel').onclick=generateModel;
    }
  }

  function dialogueOf(obj){
    if(Array.isArray(obj?.dialogue))return obj.dialogue;
    return (obj?.lines||[]).map(x=>({role:'candidate',...x}));
  }

  async function playDialogue(obj,btn){
    const old=btn.textContent; btn.disabled=true; btn.textContent='A reproduzir…';
    try{
      for(const x of dialogueOf(obj))await playStudyPhrase(x.fr,x.role==='examiner'?'man':'woman');
    }finally{
      btn.disabled=false; btn.textContent=old;
    }
  }

  function modelCard(section,obj){
    const dialogue=dialogueOf(obj);
    return `<div class="model-card"><div class="panel-head"><h4>Section ${section}</h4><button class="secondary-btn compact cycle-model-full-audio" data-section="${section}">▶ Ouvir conversa completa</button></div><p>${escapeHtml(obj?.introPt||'')}</p><div class="model-lines">${dialogue.map((x,i)=>`<div class="model-line"><span class="support-purpose">${x.role==='examiner'?'EXAMINADOR':'CANDIDATO'}</span><button class="mini-audio cycle-model-line-audio" data-section="${section}" data-i="${i}">🔊</button><strong lang="fr">${escapeHtml(x.fr||'')}</strong><small class="pronunciation-cue"><b>Lê assim:</b> ${escapeHtml(x.pronunciationPt||'')}</small><small>${escapeHtml(x.pt||'')}</small></div>`).join('')}</div></div>`;
  }

  function renderModel(){
    const c=C(),m=c.model,w=workspace();
    if(!m){generateModel();return;}
    c.phase='model'; persist();
    w.className='panel exercise-panel';
    w.innerHTML=`<div class="cycle-stage-head"><div><div class="cycle-stage-kicker">PASSO 2/4</div><h3>EXEMPLO · COMO UMA BOA CONVERSA PODIA TER ACONTECIDO</h3></div><span class="badge">${escapeHtml(c.difficulty)}</span></div>
      <p>${escapeHtml(m.coachPt||'Ouve a interação completa e repara em como o candidato reage ao examinador.')}</p>
      <div class="model-grid">${modelCard('A',m.modelA)}${modelCard('B',m.modelB)}</div>
      <div class="feedback"><h4>O que corrigir primeiro</h4><ul class="priority-list">${(m.correctionsPt||[]).map(x=>`<li>${escapeHtml(x)}</li>`).join('')}</ul></div>
      <div class="cycle-next-box"><div><strong>Próximo: perguntas, objeções e argumentos</strong><small>Treina linguagem reutilizável antes do exame final.</small></div><button id="cycleToVocab" class="primary-btn">TREINAR VOCABULÁRIO</button></div>`;

    $$('.cycle-model-line-audio',w).forEach(b=>{
      const obj=b.dataset.section==='A'?m.modelA:m.modelB;
      const x=dialogueOf(obj)[Number(b.dataset.i)];
      if(x)b.onclick=()=>playStudyPhrase(x.fr,x.role==='examiner'?'man':'woman',b);
    });
    $$('.cycle-model-full-audio',w).forEach(b=>{
      const obj=b.dataset.section==='A'?m.modelA:m.modelB;
      b.onclick=()=>playDialogue(obj,b);
    });
    const advanceToVocab=()=>{c.phase='vocab';persist();renderVocab();};
    $('#cycleToVocab').onclick=advanceToVocab;
    attachGuideBar({
      here:'Passo 2/4 · Exemplo AI',
      next:'Passo 3/4 · Vocabulário',
      onBack:c.assistedResults.B?.evaluation?()=>renderSectionResult('B',true,c.assistedResults.B.evaluation):null,
      onNext:advanceToVocab,
      onReturn:renderModel
    });
    scrollWork();
  }

  function vocabList(){
    const c=C();
    return ((c.model?.vocab?.length?c.model.vocab:c.package?.baselineVocab)||[]).slice(0,12);
  }
  function knownCount(){
    const c=C(),list=vocabList();
    return list.filter((_,i)=>c.vocabProgress?.[i]==='known').length;
  }

  function renderVocab(){
    const c=C(),list=vocabList(),w=workspace();
    if(!list.length){toast('Ainda não tenho vocabulário para este ciclo.','error');return;}
    c.phase='vocab';
    c.vocabIndex=Math.max(0,Math.min(c.vocabIndex||0,list.length-1));
    persist();
    const i=c.vocabIndex,x=list[i],known=knownCount();
    w.className='panel exercise-panel';
    w.innerHTML=`<div class="cycle-stage-head"><div><div class="cycle-stage-kicker">PASSO 3/4</div><h3>PERGUNTAS · OBJEÇÕES · ARGUMENTOS</h3></div><span class="badge">${known}/${list.length} DOMINADAS</span></div>
      <div class="vocab-trainer"><div class="vocab-progress-row"><span>Frase ${i+1}/${list.length}</span><strong>${Math.round(known/list.length*100)}%</strong></div><div class="progress-track"><div class="progress-bar" style="width:${known/list.length*100}%"></div></div>
      <div class="vocab-card-large"><span class="vocab-category">${escapeHtml(x.category||'expressão útil')}</span><div class="vocab-fr" lang="fr">${escapeHtml(x.fr||'')}</div><button id="cycleVocabAudio" class="secondary-btn">▶ Ouvir</button><button id="cycleVocabHelp" class="secondary-btn">Mostrar significado</button><div id="cycleVocabHelpBox" class="vocab-help hidden"><div class="pronunciation-cue"><b>Lê assim:</b> ${escapeHtml(x.pronunciationPt||'')}</div><p>${escapeHtml(x.pt||'')}</p></div></div>
      <div class="vocab-nav"><button id="cycleVocabPrev" class="secondary-btn" ${i===0?'disabled':''}>← Anterior</button><button id="cycleVocabReview" class="danger-ghost">REVER</button><button id="cycleVocabKnown" class="primary-btn">SEI ESTA</button><button id="cycleVocabNext" class="secondary-btn" ${i===list.length-1?'disabled':''}>Seguinte →</button></div>
      <div class="cycle-next-box"><div><strong>Depois: exame final com AI examinador</strong><small>Section A = 5 min · Section B = 10 min · sem ajuda.</small></div><button id="cycleStartFinal" class="primary-btn">EXAME FINAL SEM AJUDA</button></div></div>`;

    $('#cycleVocabAudio').onclick=()=>playStudyPhrase(x.fr,'neutral',$('#cycleVocabAudio'));
    $('#cycleVocabHelp').onclick=()=>{
      const box=$('#cycleVocabHelpBox');
      const hidden=box.classList.toggle('hidden');
      $('#cycleVocabHelp').textContent=hidden?'Mostrar significado':'Ocultar significado';
    };
    $('#cycleVocabPrev').onclick=()=>{c.vocabIndex--;persist();renderVocab();};
    $('#cycleVocabNext').onclick=()=>{c.vocabIndex++;persist();renderVocab();};
    $('#cycleVocabReview').onclick=()=>{c.vocabProgress[i]='review';if(i<list.length-1)c.vocabIndex++;persist();renderVocab();};
    $('#cycleVocabKnown').onclick=()=>{c.vocabProgress[i]='known';if(i<list.length-1)c.vocabIndex++;persist();renderVocab();};
    const advanceToFinal=()=>renderInteractive('A',false,true);
    $('#cycleStartFinal').onclick=advanceToFinal;
    attachGuideBar({
      here:'Passo 3/4 · Vocabulário',
      next:'Passo 4/4 · TEF sem ajuda',
      onBack:()=>renderModel(),
      onNext:advanceToFinal,
      onReturn:renderVocab
    });
    scrollWork();
  }

  function finishCycle(){
    stopLocalMedia();
    const c=C();
    c.phase='completed'; c.active=false; c.completedAt=new Date().toISOString();
    persist();
    renderSummary();
  }

  function delta(final,assisted){
    const d=scoreOf(final)-scoreOf(assisted);
    return d>0?'+'+d:String(d);
  }

  function renderSummary(){
    const c=C(),w=workspace();
    w.className='panel exercise-panel';
    const a1=scoreOf(c.assistedResults.A),b1=scoreOf(c.assistedResults.B),a2=scoreOf(c.finalResults.A),b2=scoreOf(c.finalResults.B);
    w.innerHTML=`<div class="final-cycle-summary"><div class="cycle-stage-head"><div><div class="cycle-stage-kicker">CICLO CONCLUÍDO</div><h3>Treino assistido → conversa realista sem ajuda</h3></div><span class="badge">GUARDADO</span></div>
      <div class="cycle-score-grid"><div class="cycle-score"><span>A · assistido</span><strong>${a1}/100</strong></div><div class="cycle-score"><span>B · assistido</span><strong>${b1}/100</strong></div><div class="cycle-score"><span>A · final</span><strong>${a2}/100</strong><small>${delta(c.finalResults.A,c.assistedResults.A)} vs assistido</small></div><div class="cycle-score"><span>B · final</span><strong>${b2}/100</strong><small>${delta(c.finalResults.B,c.assistedResults.B)} vs assistido</small></div></div>
      <div class="mock-rule"><strong>Nota:</strong> o AI faz o papel de interlocutor para treino realista. Continua a ser uma simulação; a avaliação oficial pertence ao TEF.</div>
      <div class="hero-actions"><button id="cycleReviewVocab" class="secondary-btn">Rever vocabulário</button><button id="cycleToPlan" class="primary-btn">Abrir Plano AI</button><button id="cycleNew" class="secondary-btn">Novo ciclo</button></div></div>`;
    $('#cycleReviewVocab').onclick=()=>{c.phase='vocab';c.active=true;persist();renderVocab();};
    $('#cycleToPlan').onclick=()=>navigate('plan');
    $('#cycleNew').onclick=resetCycle;
    attachGuideBar({
      here:'Ciclo concluído',
      next:'Plano AI',
      onBack:c.finalResults.B?.evaluation?()=>renderSectionResult('B',false,c.finalResults.B.evaluation):()=>renderVocab(),
      onNext:()=>navigate('plan'),
      onReturn:renderSummary
    });
    scrollWork();
  }

  function resume(){
    const c=C();
    if(!c.package){startNew();return;}
    if(c.phase==='assistedA')renderInteractive('A',true,false);
    else if(c.phase==='assistedB')renderInteractive('B',true,false);
    else if(c.phase==='modelPending')generateModel();
    else if(c.phase==='model')renderModel();
    else if(c.phase==='vocab')renderVocab();
    else if(c.phase==='finalA')renderInteractive('A',false,false);
    else if(c.phase==='finalB')renderInteractive('B',false,false);
    else if(c.phase==='completed')renderSummary();
    else startNew();
  }

  function wire(){
    renderCyclePanel();
    $('#startExamCycle')?.addEventListener('click',()=>{
      const c=C();
      if(c.active||c.phase==='completed')resume();
      else startNew();
    });
    $('#resetExamCycle')?.addEventListener('click',()=>{
      if(confirm('Recomeçar este ciclo? O histórico geral não será apagado.'))resetCycle();
    });
    $('.nav-item[data-page="speaking"]')?.addEventListener('click',()=>{
      setTimeout(()=>{
        renderCyclePanel();
        if(C().active||C().phase==='completed')resume();
      },40);
    });
  }

  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',wire);
  else wire();
})();