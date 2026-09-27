(() => {
  const workspace=()=>$('#speakingWorkspace');
  const phaseNames={
    assistedA:'1/4 · Exame com ajuda · Section A',
    assistedB:'1/4 · Exame com ajuda · Section B',
    modelPending:'2/4 · Preparar exemplo AI',
    model:'2/4 · Exemplo AI falado + escrito',
    vocab:'3/4 · Vocabulário de argumentação',
    finalA:'4/4 · Exame final sem ajuda · Section A',
    finalB:'4/4 · Exame final sem ajuda · Section B',
    completed:'Ciclo concluído'
  };

  function blank(){
    return {version:1,id:null,active:false,phase:'idle',difficulty:'B1',package:null,assistedResults:{},model:null,vocabProgress:{},vocabIndex:0,finalResults:{},startedAt:null,completedAt:null};
  }
  function C(){
    if(!state.speakingExamCycle || state.speakingExamCycle.version!==1) state.speakingExamCycle=blank();
    return state.speakingExamCycle;
  }
  function persist(){saveState();renderCyclePanel();}
  function scoreOf(obj){return Number(obj?.evaluation?.overall)||0;}
  function scrollWork(){setTimeout(()=>workspace()?.scrollIntoView({behavior:'smooth',block:'start'}),80);}
  function phaseText(){const c=C();return c.phase==='idle'?'Ainda não iniciado.':(phaseNames[c.phase]||c.phase);}
  function renderCyclePanel(){
    const c=C(), status=$('#examCycleStatus'), start=$('#startExamCycle'), reset=$('#resetExamCycle'), sel=$('#cycleDifficulty'), badge=$('#examCycleBadge');
    if(!status||!start)return;
    status.textContent=c.phase==='completed'?'Concluído. Podes rever resultados ou iniciar um novo ciclo.':c.active?`Em curso: ${phaseText()}`:'Ainda não iniciado.';
    start.textContent=c.active?'RETOMAR CICLO':c.phase==='completed'?'VER RESULTADO / NOVO CICLO':'INICIAR CICLO COMPLETO';
    if(sel){sel.value=c.difficulty||'B1';sel.disabled=Boolean(c.active);}
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
      w.innerHTML=`<span class="loader"></span><strong>A preparar ciclo TEF · ${escapeHtml(c.difficulty)}</strong><small>Vou criar uma prova assistida e uma prova final diferente.</small>`;
    }
    try{
      const {cycle}=await api('/api/generate-speaking-cycle',{difficulty:c.difficulty});
      C().package=cycle;
      persist();
      renderAssisted('A');
    }catch(e){
      C().active=false;C().phase='idle';persist();
      if(w)w.innerHTML=`<div class="feedback feedback-retry"><strong>Não consegui criar o ciclo.</strong><p>${escapeHtml(friendlyError(e))}</p></div>`;
      toast(friendlyError(e),'error');
    }finally{
      setBusy(btn,false);
    }
  }

  function resetCycle(){
    state.speakingExamCycle=blank();
    persist();
    const w=workspace();
    if(w){
      w.className='panel exercise-panel empty-state';
      w.innerHTML='<div class="empty-icon">→</div><h3>Ciclo reiniciado.</h3><p>Escolhe a dificuldade e inicia novamente.</p>';
    }
  }

  function assistedTask(section){
    const c=C(),src=c.package?.assisted?.[section];
    if(!src)return null;
    return {...src,assisted:true,noHelp:false,_cycleId:c.id,_cycleStage:'assisted'+section,cycleLabel:'EXAME COM AJUDA PT'};
  }
  function finalTask(section){
    const c=C(),src=c.package?.final?.[section];
    if(!src)return null;
    return {...src,assisted:false,noHelp:true,_cycleId:c.id,_cycleStage:'final'+section,cycleLabel:'EXAME FINAL SEM AJUDA'};
  }
  function prepRender(task){
    currentSpeaking=task;
    recordedAudioDataUrl='';
    browserTranscript='';
    recordStartedAt=0;
    renderSpeaking(task,workspace());
  }

  function renderAssisted(section){
    const c=C(),task=assistedTask(section);
    if(!task){toast('O ciclo ainda não tem esta tarefa.','error');return;}
    c.active=true;
    c.phase='assisted'+section;
    persist();
    prepRender(task);
    const card=$('.task-card',workspace());
    if(!card)return;
    const support=Array.isArray(task.support)?task.support:[];
    card.insertAdjacentHTML('afterend',`<div class="assisted-help-card">
      <h4>AJUDA TOTAL EM PORTUGUÊS</h4>
      <div class="assisted-translation"><strong>O que a consigne quer dizer:</strong>\n${escapeHtml(task.promptPt||'')}</div>
      <div class="support-phrase-list">${support.map((x,i)=>`<div class="support-phrase"><button class="mini-audio cycle-support-audio" data-i="${i}">🔊</button><div><span class="support-purpose">${escapeHtml(x.purposePt||'Frase útil')}</span><strong lang="fr">${escapeHtml(x.fr||'')}</strong><small class="pronunciation-cue"><b>Lê assim:</b> ${escapeHtml(x.pronunciationPt||'')}</small><small>${escapeHtml(x.pt||'')}</small></div></div>`).join('')}</div>
    </div>`);
    $$('.cycle-support-audio',workspace()).forEach(b=>{
      const x=support[Number(b.dataset.i)];
      b.onclick=()=>playStudyPhrase(x.fr,'neutral',b);
    });
    workspace().insertAdjacentHTML('afterbegin',`<div class="cycle-banner"><strong>PASSO 1/4 · EXAME COM AJUDA · SECTION ${section}</strong><span>Podes usar a tradução, as frases e a pronúncia. O objetivo agora é aprender o formato — esta tentativa não entra na readiness.</span></div>`);
    scrollWork();
  }

  function showPostEvalAction(stage){
    const w=workspace();
    if(!w)return;
    let label='',id='';
    if(stage==='assistedA'){label='CONTINUAR PARA SECTION B COM AJUDA';id='cycleNextB';}
    else if(stage==='assistedB'){label='VER EXEMPLO AI FALADO + ESCRITO';id='cycleMakeModel';}
    else if(stage==='finalA'){label='CONTINUAR PARA SECTION B SEM AJUDA';id='cycleFinalB';}
    else if(stage==='finalB'){label='VER RESULTADO FINAL';id='cycleFinish';}
    if(!id)return;
    w.insertAdjacentHTML('beforeend',`<div class="cycle-next-box"><div><strong>${escapeHtml(label)}</strong><small>O resultado anterior fica guardado.</small></div><button id="${id}" class="primary-btn">${escapeHtml(label)}</button></div>`);
    if(stage==='assistedA')$('#'+id).onclick=()=>renderAssisted('B');
    if(stage==='assistedB')$('#'+id).onclick=generateModel;
    if(stage==='finalA')$('#'+id).onclick=()=>renderFinal('B');
    if(stage==='finalB')$('#'+id).onclick=finishCycle;
  }

  async function generateModel(){
    const c=C();
    c.phase='modelPending';
    persist();
    const w=workspace();
    w.className='panel exercise-panel sim-loading';
    w.innerHTML='<span class="loader"></span><strong>A criar o exemplo AI</strong><small>Vou usar as tuas respostas assistidas para criar um exemplo forte e vocabulário específico de argumentação.</small>';
    try{
      const {model}=await api('/api/speaking-cycle-model',{assisted:c.package.assisted,results:c.assistedResults});
      c.model=model;
      c.phase='model';
      c.active=true;
      const vocab=(model.vocab||[]).map(x=>({fr:x.fr,pt:x.pt,pronunciationPt:x.pronunciationPt,source:'speaking-argumentation'}));
      addVocab(vocab);
      persist();
      renderModel();
    }catch(e){
      c.phase='modelPending';
      persist();
      w.innerHTML=`<div class="feedback feedback-retry"><strong>Falha a criar o exemplo.</strong><p>${escapeHtml(friendlyError(e))}</p><button id="retryCycleModel" class="primary-btn">Tentar novamente</button></div>`;
      $('#retryCycleModel').onclick=generateModel;
    }
  }

  function modelCard(section,obj){
    const lines=Array.isArray(obj?.lines)?obj.lines:[];
    return `<div class="model-card"><div class="panel-head"><h4>Section ${section}</h4><button class="secondary-btn compact cycle-model-full-audio" data-section="${section}">▶ Ouvir exemplo completo</button></div><p>${escapeHtml(obj?.introPt||'')}</p><div class="model-lines">${lines.map((x,i)=>`<div class="model-line"><button class="mini-audio cycle-model-line-audio" data-section="${section}" data-i="${i}">🔊</button><strong lang="fr">${escapeHtml(x.fr||'')}</strong><small class="pronunciation-cue"><b>Lê assim:</b> ${escapeHtml(x.pronunciationPt||'')}</small><small>${escapeHtml(x.pt||'')}</small></div>`).join('')}</div></div>`;
  }

  function renderModel(){
    const c=C(),m=c.model,w=workspace();
    if(!m){generateModel();return;}
    c.phase='model';
    persist();
    w.className='panel exercise-panel';
    w.innerHTML=`<div class="cycle-stage-head"><div><div class="cycle-stage-kicker">PASSO 2/4</div><h3>EXEMPLO AI · FALADO + ESCRITO</h3></div><span class="badge">${escapeHtml(c.difficulty)}</span></div>
      <p>${escapeHtml(m.coachPt||'Ouve e lê o exemplo. Não é para decorar palavra por palavra; repara na estrutura.')}</p>
      <div class="model-grid">${modelCard('A',m.modelA)}${modelCard('B',m.modelB)}</div>
      <div class="feedback"><h4>O que corrigir primeiro</h4><ul class="priority-list">${(m.correctionsPt||[]).map(x=>`<li>${escapeHtml(x)}</li>`).join('')}</ul></div>
      <div class="cycle-next-box"><div><strong>Próximo: vocabulário de argumentação</strong><small>Treina frases reutilizáveis antes da prova sem ajuda.</small></div><button id="cycleToVocab" class="primary-btn">TREINAR VOCABULÁRIO</button></div>`;
    $$('.cycle-model-line-audio',w).forEach(b=>{
      const sec=b.dataset.section,obj=sec==='A'?m.modelA:m.modelB,x=obj.lines[Number(b.dataset.i)];
      b.onclick=()=>playStudyPhrase(x.fr,'neutral',b);
    });
    $$('.cycle-model-full-audio',w).forEach(b=>{
      const obj=b.dataset.section==='A'?m.modelA:m.modelB;
      const txt=(obj.lines||[]).map(x=>x.fr).join(' ');
      b.onclick=()=>playStudyPhrase(txt,'neutral',b);
    });
    $('#cycleToVocab').onclick=()=>{c.phase='vocab';persist();renderVocab();};
    scrollWork();
  }

  function vocabList(){
    const c=C();
    const list=(c.model?.vocab?.length?c.model.vocab:c.package?.baselineVocab)||[];
    return list.slice(0,12);
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
    w.innerHTML=`<div class="cycle-stage-head"><div><div class="cycle-stage-kicker">PASSO 3/4</div><h3>VOCABULÁRIO DE ARGUMENTAÇÃO</h3></div><span class="badge">${known}/${list.length} DOMINADAS</span></div>
      <div class="vocab-trainer"><div class="vocab-progress-row"><span>Frase ${i+1}/${list.length}</span><strong>${Math.round(known/list.length*100)}%</strong></div><div class="progress-track"><div class="progress-bar" style="width:${known/list.length*100}%"></div></div>
      <div class="vocab-card-large"><span class="vocab-category">${escapeHtml(x.category||'argumentação')}</span><div class="vocab-fr" lang="fr">${escapeHtml(x.fr||'')}</div><button id="cycleVocabAudio" class="secondary-btn">▶ Ouvir</button><button id="cycleVocabHelp" class="secondary-btn">Mostrar significado</button><div id="cycleVocabHelpBox" class="vocab-help hidden"><div class="pronunciation-cue"><b>Lê assim:</b> ${escapeHtml(x.pronunciationPt||'')}</div><p>${escapeHtml(x.pt||'')}</p></div></div>
      <div class="vocab-nav"><button id="cycleVocabPrev" class="secondary-btn" ${i===0?'disabled':''}>← Anterior</button><button id="cycleVocabReview" class="danger-ghost">REVER</button><button id="cycleVocabKnown" class="primary-btn">SEI ESTA</button><button id="cycleVocabNext" class="secondary-btn" ${i===list.length-1?'disabled':''}>Seguinte →</button></div>
      <div class="cycle-next-box"><div><strong>Quando estiveres pronto: exame final sem ajuda</strong><small>Recomendação: tenta dominar pelo menos 70%, mas não fica bloqueado.</small></div><button id="cycleStartFinal" class="primary-btn">EXAME FINAL SEM AJUDA</button></div></div>`;
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
    $('#cycleStartFinal').onclick=()=>renderFinal('A');
    scrollWork();
  }

  function renderFinal(section){
    const c=C(),task=finalTask(section);
    if(!task){toast('A tarefa final não está disponível.','error');return;}
    c.phase='final'+section;
    c.active=true;
    persist();
    prepRender(task);
    workspace().insertAdjacentHTML('afterbegin',`<div class="cycle-banner"><strong>PASSO 4/4 · EXAME FINAL SEM AJUDA · SECTION ${section}</strong><span>Nova tarefa. Sem tradução, sem frases sugeridas e sem pronúncia. Usa o que aprendeste.</span></div>`);
    scrollWork();
  }

  function finishCycle(){
    const c=C();
    c.phase='completed';
    c.active=false;
    c.completedAt=new Date().toISOString();
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
    w.innerHTML=`<div class="final-cycle-summary"><div class="cycle-stage-head"><div><div class="cycle-stage-kicker">CICLO CONCLUÍDO</div><h3>Resultado do treino assistido → prova sem ajuda</h3></div><span class="badge">GUARDADO</span></div>
      <div class="cycle-score-grid"><div class="cycle-score"><span>A · assistido</span><strong>${a1}/100</strong></div><div class="cycle-score"><span>B · assistido</span><strong>${b1}/100</strong></div><div class="cycle-score"><span>A · final</span><strong>${a2}/100</strong><small>${delta(c.finalResults.A,c.assistedResults.A)} vs assistido</small></div><div class="cycle-score"><span>B · final</span><strong>${b2}/100</strong><small>${delta(c.finalResults.B,c.assistedResults.B)} vs assistido</small></div></div>
      <div class="mock-rule"><strong>Importante:</strong> estes valores são métricas internas de treino, não scores oficiais TEF. O que interessa é repetir ciclos até conseguires produzir a estrutura sem ajuda.</div>
      <div class="hero-actions"><button id="cycleReviewVocab" class="secondary-btn">Rever vocabulário</button><button id="cycleToPlan" class="primary-btn">Abrir Plano AI</button><button id="cycleNew" class="secondary-btn">Novo ciclo</button></div></div>`;
    $('#cycleReviewVocab').onclick=()=>{c.phase='vocab';c.active=true;persist();renderVocab();};
    $('#cycleToPlan').onclick=()=>navigate('plan');
    $('#cycleNew').onclick=()=>resetCycle();
    scrollWork();
  }

  function resume(){
    const c=C();
    if(!c.package){startNew();return;}
    if(c.phase==='assistedA')renderAssisted('A');
    else if(c.phase==='assistedB')renderAssisted('B');
    else if(c.phase==='modelPending')generateModel();
    else if(c.phase==='model')renderModel();
    else if(c.phase==='vocab')renderVocab();
    else if(c.phase==='finalA')renderFinal('A');
    else if(c.phase==='finalB')renderFinal('B');
    else if(c.phase==='completed')renderSummary();
    else startNew();
  }

  window.addEventListener('target6:speaking-evaluated',e=>{
    const d=e.detail||{},task=d.task||{},c=C();
    if(!task._cycleId || task._cycleId!==c.id)return;
    const stage=task._cycleStage;
    const payload={evaluation:d.evaluation,transcript:d.transcript,durationSeconds:d.durationSeconds,at:new Date().toISOString()};
    if(stage==='assistedA'){c.assistedResults.A=payload;c.phase='assistedB';}
    if(stage==='assistedB'){c.assistedResults.B=payload;c.phase='modelPending';}
    if(stage==='finalA'){c.finalResults.A=payload;c.phase='finalB';}
    if(stage==='finalB'){c.finalResults.B=payload;c.phase='completed';}
    persist();
    showPostEvalAction(stage);
  });

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
    $('.nav-item[data-page="speaking"]')?.addEventListener('click',()=>setTimeout(renderCyclePanel,0));
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',wire);
  else wire();
})();