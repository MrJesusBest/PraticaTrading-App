(() => {
  const flow=window.Target6SpeakingFlow;
  if(!flow){ console.error('TARGET6_SPEAKING_FLOW_MISSING'); return; }

  const curriculum={
    A:[
      ['a_greeting','Abrir a conversa','Bonjour, je vous appelle pour avoir des renseignements.','Olá, estou a ligar para obter informações.','Bonjúr, jə vu zapél pur avuár de rãseñmã.'],
      ['a_price','Perguntar o preço','Combien coûte la balade ?','Quanto custa o passeio?','Com-biã kut la balád?'],
      ['a_time','Perguntar a hora','À quelle heure commence la balade ?','A que horas começa o passeio?','A kel eur comãs la balád?'],
      ['a_date','Perguntar o dia','Quel jour est-ce que la balade a lieu ?','Em que dia acontece o passeio?','Kel jur és-kə la balád a liø?'],
      ['a_place','Perguntar o local','Où est le point de départ ?','Onde é o ponto de partida?','U é lə puã də depár?'],
      ['a_duration','Perguntar a duração','Combien de temps dure la balade ?','Quanto tempo dura o passeio?','Com-biã də tã dyr la balád?'],
      ['a_people','Perguntar participantes','Combien de personnes peuvent participer ?','Quantas pessoas podem participar?','Com-biã də pérson pøv partissipê?'],
      ['a_equipment','Perguntar equipamento','Faut-il apporter un casque ?','É preciso levar um capacete?','Fo-til aportê ãn kásk?'],
      ['a_weather','Perguntar sobre chuva',"Que se passe-t-il s'il pleut ?",'O que acontece se chover?','Kə sə pass-til sil plø?'],
      ['a_close','Fechar a conversa','Merci beaucoup pour les informations.','Muito obrigado pelas informações.','Mérssi bocú pur lez ãnformassiõ.']
    ],
    B:[
      ['b_opinion','Dar opinião',"Je pense que c'est une bonne idée.",'Penso que é uma boa ideia.','Jə pãs kə sé tyn bon idê.'],
      ['b_reason','Dar uma razão',"Je pense que c'est une bonne idée parce que c'est pratique.",'Penso que é uma boa ideia porque é prático.','Jə pãs kə sé tyn bon idê parskə sé pratik.'],
      ['b_structure','Organizar argumentos',"D'abord, c'est pratique. Ensuite, c'est économique.",'Primeiro, é prático. Depois, é económico.','Dabór, sé pratik. Ãsuit, sé ekonômik.'],
      ['b_objection','Responder a objeção','Je comprends, mais je pense que cela vaut la peine.','Eu compreendo, mas penso que vale a pena.','Jə comprã, mé jə pãs kə səla vo la pén.'],
      ['b_example','Dar exemplo','Par exemple, on peut y aller en famille.','Por exemplo, podemos ir em família.','Par egzãpl, õ pø i alê ã famí.'],
      ['b_compare','Comparar opções',"C'est plus intéressant que de rester à la maison.",'É mais interessante do que ficar em casa.','Sé plyz ãteressã kə də restê a la mezõ.'],
      ['b_close','Tentar convencer',"Alors, qu'est-ce que tu en penses ?",'Então, o que achas?','Alór, kés-kə ty ã pãs?']
    ]
  };
  const ids={A:curriculum.A.map(x=>x[0]),B:curriculum.B.map(x=>x[0])};
  let mode='learn', guidedIndex=0, recognition=null, activeSkill=null, activeGuided=false;

  function T(){
    state.speakingTraining=flow.normalize(state.speakingTraining,ids);
    return state.speakingTraining;
  }
  function avg(section){ return flow.average(T(),ids,section); }
  function nextStage(){ return flow.nextStage(T(),ids); }
  function currentSection(){ return $('#speakingSectionSelector .seg.active')?.dataset.section || 'A'; }
  function setSection(section){
    speakingSection=section;
    $$('#speakingSectionSelector .seg').forEach(b=>b.classList.toggle('active',b.dataset.section===section));
  }
  function persist(){ saveState(); }
  function review(p,ok){
    if(!ok){ p.next=new Date().toISOString(); return; }
    const d=[1,3,7,14,30][Math.min(4,Math.max(0,p.passes-1))];
    p.next=new Date(Date.now()+d*86400000).toISOString();
  }
  function nextSkill(section){
    const t=T(), now=Date.now();
    const list=curriculum[section].map((skill,i)=>({skill,i,p:t.skills[skill[0]]}));
    const due=list.filter(x=>x.p.next && new Date(x.p.next).getTime()<=now);
    return (due.length?due:list).sort((a,b)=>a.p.mastery-b.p.mastery||a.p.tries-b.p.tries||a.i-b.i)[0].skill;
  }
  function stageLabel(){
    const t=T(), a=avg('A'), b=avg('B');
    if(a<100)return 'A0/A1 · BASE A';
    if(t.guided.A<2)return 'A2 · GUIADO A';
    if(b<100)return 'A1/B1 · BASE B';
    if(t.guided.B<2)return 'B1 · GUIADO B';
    return 'B1+ · SIMULAÇÃO TEF';
  }
  function nextLabel(n){
    if(n.code==='A_GUIDED')return 'Treino Guiado A · '+Math.min(T().guided.A,2)+'/2';
    if(n.code==='B_GUIDED')return 'Treino Guiado B · '+Math.min(T().guided.B,2)+'/2';
    if(n.code==='A_BASE')return 'Concluir Base Section A';
    if(n.code==='B_BASE')return 'Concluir Base Section B';
    return 'Simulação TEF';
  }

  function renderPath(){
    const box=$('#speakingPathOverview'); if(!box)return;
    const t=T(), a=avg('A'), b=avg('B'), n=nextStage();
    box.innerHTML=`
      <div class="path-top"><div><div class="small-label">ESTADO REAL DO SPEAKING</div><strong>${stageLabel()}</strong><p>O 100% da base não significa exame concluído. A progressão abaixo mostra exatamente o gate atual.</p></div><span class="badge">${t.total||0} micro-drills</span></div>
      <div class="mastery-row"><span>Base Section A</span><strong>${a}%</strong></div><div class="progress-track"><div class="progress-bar" style="width:${a}%"></div></div>
      <div class="guided-gate"><span>Treino Guiado A</span><strong>${Math.min(t.guided.A,2)}/2</strong></div>
      <div class="mastery-row"><span>Base Section B</span><strong>${b}%</strong></div><div class="progress-track"><div class="progress-bar" style="width:${b}%"></div></div>
      <div class="guided-gate"><span>Treino Guiado B</span><strong>${Math.min(t.guided.B,2)}/2</strong></div>
      <div class="next-gate-card"><div><span>PRÓXIMO PASSO</span><strong>${escapeHtml(nextLabel(n))}</strong></div><button id="advanceSpeakingNow" class="primary-btn">AVANÇAR AGORA</button></div>`;
    $('#advanceSpeakingNow').onclick=()=>startStage(n);

    const bBtn=$('#speakingSectionSelector .seg[data-section="B"]');
    if(bBtn){
      const preserveLegacy=avg('B')>0;
      bBtn.disabled=!(avg('A')>=45 || preserveLegacy);
      bBtn.textContent=bBtn.disabled?'Section B · mais tarde':'Section B · argumentação';
    }

    const sec=currentSection();
    const guidedBtn=$('#speakingModeSelector [data-mode="guided"]');
    const examBtn=$('#speakingModeSelector [data-mode="exam"]');
    if(guidedBtn) guidedBtn.disabled=!(avg(sec)===100 || T().guided[sec]>0);
    if(examBtn) examBtn.disabled=!flow.examReady(T(),ids);
  }

  function setMode(nextMode,{clear=false,save=true}={}){
    mode=nextMode;
    T().mode=nextMode;
    $$('#speakingModeSelector [data-mode]').forEach(b=>b.classList.toggle('active',b.dataset.mode===nextMode));
    const d=$('#speakingModeDescription');
    if(d)d.innerHTML=nextMode==='learn'
      ? '<strong>APRENDER:</strong> consolida as frases da base até 100%.'
      : nextMode==='guided'
        ? '<strong>TREINO GUIADO:</strong> 5 interações por passagem. São necessárias 2 passagens por secção.'
        : '<strong>SIMULAÇÃO TEF:</strong> formato completo, com tempo e sem ajuda inicial.';
    $('#speakingExamControls')?.classList.toggle('hidden',nextMode!=='exam');
    const start=$('#startSpeakingTraining');
    if(start) start.textContent=nextMode==='learn'?'Continuar base':nextMode==='guided'?'Começar treino guiado':'Gerar simulação TEF';
    if(save)persist();
    if(clear)renderLanding();
  }

  function renderLanding(){
    const w=$('#speakingWorkspace'); if(!w)return;
    const n=nextStage();
    w.className='panel exercise-panel empty-state';
    w.innerHTML=`<div class="empty-icon">→</div><h3>${escapeHtml(nextLabel(n))}</h3><p>O sistema preservou o teu progresso. Não precisas repetir o que já está a 100%.</p><button id="workspaceAdvance" class="primary-btn">AVANÇAR AGORA</button>`;
    $('#workspaceAdvance').onclick=()=>startStage(n);
  }

  function startStage(n){
    if(!n)n=nextStage();
    setSection(n.section);
    setMode(n.mode,{clear:false});
    renderPath();
    if(n.mode==='learn') renderDrill(nextSkill(n.section),false);
    else if(n.mode==='guided'){ guidedIndex=0; renderDrill(curriculum[n.section][0],true); }
    else generateSpeakingTask({section:n.section,difficulty:$('#speakingDifficulty')?.value||'B1'});
  }

  function renderDrill(skill,guided=false){
    activeSkill=skill; activeGuided=guided;
    const p=T().skills[skill[0]], w=$('#speakingWorkspace'); if(!w)return;
    w.className='panel exercise-panel';
    const showFull=!guided || p.mastery<55;
    const model=showFull
      ? `<div class="phrase-card"><div class="phrase-fr" lang="fr">${escapeHtml(skill[2])}</div><div class="pronunciation-cue"><b>Lê assim:</b> ${escapeHtml(skill[4])}</div><div class="phrase-pt">${escapeHtml(skill[3])}</div></div>`
      : `<div class="guided-help reduced"><span>SEM MODELO COMPLETO</span><small>Constrói a frase sozinho. Se bloqueares, mostra a ajuda.</small><button id="showModel" class="secondary-btn compact">Mostrar ajuda</button><div id="hiddenModel" class="hidden pronunciation-stack"><strong lang="fr">${escapeHtml(skill[2])}</strong><small class="pronunciation-cue"><b>Lê assim:</b> ${escapeHtml(skill[4])}</small><small class="translation-cue">${escapeHtml(skill[3])}</small></div></div>`;
    w.innerHTML=`
      <div class="panel-head"><div><div class="small-label">${guided?'TREINO GUIADO':'BASE'}</div><h3>${escapeHtml(skill[1])}</h3></div><span class="badge">Domínio ${p.mastery}%</span></div>
      ${guided?`<div class="guided-scenario"><strong>${currentSection()==='A'?'Cenário: obter informações':'Cenário: convencer outra pessoa'}</strong><small>Passo ${guidedIndex+1}/5 desta passagem guiada.</small></div>`:''}
      ${model}
      <div class="practice-loop"><div><b>1</b><span>Ouve</span></div><div><b>2</b><span>Repete</span></div><div><b>3</b><span>AI corrige</span></div><div><b>4</b><span>Repete se falhar</span></div></div>
      <div class="hero-actions"><button id="speakListen" class="secondary-btn">▶ Ouvir modelo</button><button id="speakMic" class="record-btn">● Falar</button></div>
      <textarea id="microTranscript" class="transcript-box micro-transcript" placeholder="O que disseres aparece aqui. Também podes escrever manualmente."></textarea>
      <div class="recording-controls"><button id="microEvaluate" class="primary-btn">Corrigir</button></div>
      <div id="microFeedback"></div>`;
    $('#speakListen').onclick=()=>playStudyPhrase(skill[2],'neutral',$('#speakListen'));
    $('#speakMic').onclick=startRecognition;
    $('#microEvaluate').onclick=()=>evaluateDrill(skill,guided);
    if($('#showModel'))$('#showModel').onclick=()=>$('#hiddenModel').classList.remove('hidden');
  }

  function startRecognition(){
    const SR=window.SpeechRecognition||window.webkitSpeechRecognition;
    if(!SR){ toast('Neste browser escreve a frase na caixa e clica Corrigir.','error'); return; }
    recognition=new SR(); recognition.lang='fr-FR'; recognition.interimResults=true;
    recognition.onresult=e=>{ let txt=''; for(let i=0;i<e.results.length;i++)txt+=e.results[i][0].transcript+' '; $('#microTranscript').value=txt.trim(); };
    recognition.onerror=()=>toast('Não consegui reconhecer a voz. Podes escrever a frase manualmente.','error');
    recognition.onend=()=>{ if($('#speakMic'))$('#speakMic').textContent='● Falar'; };
    recognition.start();
    $('#speakMic').textContent='● A ouvir…';
  }

  async function evaluateDrill(skill,guided){
    const txt=$('#microTranscript')?.value.trim();
    if(!txt){ toast('Fala ou escreve primeiro a frase.','error'); return; }
    const btn=$('#microEvaluate'); setBusy(btn,true,'A corrigir…');
    try{
      const {evaluation}=await api('/api/evaluate-speaking-drill',{section:currentSection(),skillId:skill[0],modelFr:skill[2],learnerTranscript:txt,guided});
      const p=T().skills[skill[0]], score=Number(evaluation.score||0), ok=Boolean(evaluation.achieved)&&score>=70;
      p.tries++; p.lastScore=score;
      if(ok){ p.passes++; p.mastery=Math.min(100,p.mastery+(guided?15:20)); T().completed[currentSection()]++; T().total++; }
      else p.mastery=Math.max(0,p.mastery-8);
      review(p,ok); persist(); renderPath(); maybeFinishDiagnostic();

      const after=ok
        ? (guided?'Continuar treino guiado':(avg(currentSection())===100?'AVANÇAR AGORA':'Próxima frase'))
        : 'Repetir agora';
      $('#microFeedback').innerHTML=`<div class="feedback ${ok?'feedback-pass':'feedback-retry'}"><div class="panel-head"><h3>${ok?'✓ Boa':'↻ Repete'}</h3><span class="badge">${score}/100</span></div><p>${escapeHtml(evaluation.feedbackPt||'')}</p><div class="correction-line"><span>Forma recomendada</span><div class="correction-stack"><strong lang="fr">${escapeHtml(evaluation.correctedFr||skill[2])}</strong><small class="pronunciation-cue"><b>Lê assim:</b> ${escapeHtml(evaluation.pronunciationPt||skill[4])}</small></div><button id="hearCorrection" class="mini-audio">🔊</button></div><button id="afterEval" class="primary-btn">${after}</button></div>`;
      $('#hearCorrection').onclick=()=>playStudyPhrase(evaluation.correctedFr||skill[2],'neutral',$('#hearCorrection'));
      $('#afterEval').onclick=()=>{
        if(!ok){ renderDrill(skill,guided); return; }
        if(guided){
          guidedIndex++;
          if(guidedIndex>=5){
            T().guided[currentSection()]++;
            persist(); renderPath();
            const n=nextStage();
            const w=$('#speakingWorkspace');
            w.innerHTML=`<div class="guided-complete"><div class="empty-icon">✓</div><h3>Passagem guiada concluída.</h3><p>Estado: ${Math.min(T().guided[currentSection()],2)}/2. Próximo: <strong>${escapeHtml(nextLabel(n))}</strong>.</p><button id="guidedAdvanceNow" class="primary-btn">AVANÇAR AGORA</button></div>`;
            $('#guidedAdvanceNow').onclick=()=>startStage(n);
            return;
          }
          renderDrill(curriculum[currentSection()][guidedIndex],true);
          return;
        }
        if(avg(currentSection())===100){ startStage(nextStage()); return; }
        renderDrill(nextSkill(currentSection()),false);
      };
    }catch(e){ toast(friendlyError(e),'error'); }
    finally{ setBusy(btn,false); }
  }

  function maybeFinishDiagnostic(){
    if(state.diagnostic?.active && state.diagnostic?.listeningDone && !state.diagnostic.completed && T().completed.A>=5){
      state.diagnostic.speakingBaseline=true; state.diagnostic.completed=true; state.diagnostic.active=false;
      state.diagnostic.completedAt=new Date().toISOString(); state.sessions=(state.sessions||0)+1;
      logHistory('Diagnóstico','Nivelamento oral progressivo','Concluído'); persist();
      toast('Nivelamento concluído. O progresso ficou guardado.');
    }
  }

  function startCurrent(){
    const sec=currentSection();
    if(mode==='learn'){ renderDrill(nextSkill(sec),false); return; }
    if(mode==='guided'){
      if(!(avg(sec)===100 || T().guided[sec]>0)){ toast('Primeiro conclui a base desta secção.','error'); return; }
      guidedIndex=0; renderDrill(curriculum[sec][0],true); return;
    }
    if(!flow.examReady(T(),ids)){ toast('A Simulação TEF abre depois dos dois treinos guiados A e B.','error'); return; }
    generateSpeakingTask({section:sec,difficulty:$('#speakingDifficulty')?.value||'B1'});
  }

  window.startProgressiveDiagnostic=()=>{
    navigate('speaking'); setSection('A'); setMode('learn',{clear:false}); renderPath(); renderDrill(nextSkill('A'),false);
    toast('Retoma o nivelamento oral exatamente onde paraste.');
  };

  function wire(){
    T();
    $$('#speakingModeSelector [data-mode]').forEach(b=>b.onclick=()=>{
      const m=b.dataset.mode;
      if(b.disabled){ toast(m==='exam'?'A simulação ainda está bloqueada pelo progresso.':'Conclui primeiro a base desta secção.','error'); return; }
      setMode(m,{clear:true});
    });
    $$('#speakingSectionSelector .seg').forEach(b=>b.onclick=()=>{
      if(b.disabled)return;
      setSection(b.dataset.section); setMode('learn',{clear:true}); renderPath();
    });
    $('#startSpeakingTraining')?.addEventListener('click',startCurrent);
    $('.nav-item[data-page="speaking"]')?.addEventListener('click',()=>setTimeout(()=>{ renderPath(); renderLanding(); },0));
    $('#generateSpeaking')?.classList.add('hidden');

    const n=nextStage();
    setSection(n.section);
    mode=n.mode;
    setMode(mode,{clear:false,save:false});
    renderPath();
    renderLanding();
    persist();
  }

  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',wire);
  else wire();
})();