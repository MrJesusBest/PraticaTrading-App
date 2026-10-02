(() => {
  const workspace = () => $('#speakingWorkspace');
  const stages = [
    { id:'fullA', section:'A', mode:'full', source:'assisted', label:'COM AJUDA', next:'Repetir Section A com ajuda mínima' },
    { id:'minimalA', section:'A', mode:'minimal', source:'assisted', label:'AJUDA MÍNIMA', next:'Section B com ajuda' },
    { id:'fullB', section:'B', mode:'full', source:'assisted', label:'COM AJUDA', next:'Repetir Section B com ajuda mínima' },
    { id:'minimalB', section:'B', mode:'minimal', source:'assisted', label:'AJUDA MÍNIMA', next:'Nova prova sem ajuda' },
    { id:'finalA', section:'A', mode:'final', source:'final', label:'SEM AJUDA', next:'Section B sem ajuda' },
    { id:'finalB', section:'B', mode:'final', source:'final', label:'SEM AJUDA', next:'Resultado + revisão' }
  ];

  let recorder = null;
  let stream = null;
  let chunks = [];
  let hardStopTimer = null;
  let recordContext = null;
  let submitting = false;
  let stageClockTimer = null;

  function fresh(){
    return {
      version:2,
      id:null,
      active:false,
      difficulty:'B1',
      package:null,
      stageIndex:0,
      interactions:{},
      results:{},
      mistakes:[],
      helpTaps:0,
      correctedCount:0,
      startedAt:null,
      completedAt:null
    };
  }

  function S(){
    if(!state.tefAiCoach || state.tefAiCoach.version !== 2){
      state.tefAiCoach = fresh();
    }
    return state.tefAiCoach;
  }

  function persist(){
    saveState();
    renderPanel();
  }

  function currentStage(){
    return stages[Math.max(0, Math.min(S().stageIndex || 0, stages.length - 1))];
  }

  function modeInfo(mode){
    if(mode === 'full') return {
      cls:'coach-full',
      title:'COM AJUDA',
      subtitle:'Português + dicas + correção ao vivo. A AI só interrompe quando o erro vale a pena corrigir.'
    };
    if(mode === 'minimal') return {
      cls:'coach-minimal',
      title:'AJUDA MÍNIMA',
      subtitle:'A mesma tarefa. Só recebes uma pista quando bloqueias ou quando há um erro importante.'
    };
    return {
      cls:'coach-final',
      title:'SEM AJUDA — SIMULAÇÃO',
      subtitle:'Nova tarefa. Sem português, sem sugestões e sem vocabulário durante a prova.'
    };
  }

  function taskFor(stage){
    const c=S();
    const src = stage.source === 'final' ? c.package?.final?.[stage.section] : c.package?.assisted?.[stage.section];
    if(!src) return null;
    return { ...src, _coachStage:stage.id, _coachMode:stage.mode };
  }

  function runtime(stage, reset=false){
    const c=S();
    if(reset || !c.interactions[stage.id]){
      c.interactions[stage.id] = {
        conversation:[],
        candidateTurns:[],
        startedAt:Date.now(),
        completed:false,
        evaluation:null,
        helpIndex:0,
        helpLevel:0,
        guideStep:0,
        guideCompleted:false,
        pending:null
      };
    }
    return c.interactions[stage.id];
  }

  function injectStyles(){
    if(document.getElementById('tefAiCoachStyles')) return;
    const st=document.createElement('style');
    st.id='tefAiCoachStyles';
    st.textContent =
      '.tef-coach-mode{padding:14px 16px;border-radius:14px;margin:12px 0 16px;border:1px solid rgba(255,255,255,.12)}' +
      '.tef-coach-mode strong{display:block;font-size:1rem;margin-bottom:3px}.tef-coach-mode span{font-size:.86rem;opacity:.86}' +
      '.coach-full{background:rgba(23,185,120,.12);border-color:rgba(23,185,120,.45)}' +
      '.coach-minimal{background:rgba(222,170,36,.11);border-color:rgba(222,170,36,.42)}' +
      '.coach-final{background:rgba(225,75,75,.10);border-color:rgba(225,75,75,.42)}' +
      '.tef-coach-progress{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin:12px 0}' +
      '.tef-coach-progress div{padding:9px;border-radius:10px;background:rgba(255,255,255,.04);font-size:.76rem;text-align:center}' +
      '.tef-coach-progress .active{outline:1px solid rgba(67,224,167,.7);background:rgba(67,224,167,.08)}' +
      '.coach-intervention{margin:14px 0;padding:16px;border-radius:14px;background:rgba(222,170,36,.09);border:1px solid rgba(222,170,36,.35)}' +
      '.coach-intervention h4{margin:0 0 8px}.coach-hints{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin:12px 0}' +
      '.coach-hint-box{padding:10px;border-radius:10px;background:rgba(255,255,255,.05);margin:8px 0}' +
      '.coach-metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin:14px 0}' +
      '.coach-metrics div{padding:12px;border-radius:12px;background:rgba(255,255,255,.05)}' +
      '.coach-metrics span{display:block;font-size:.72rem;opacity:.7}.coach-metrics strong{font-size:1.05rem}' +
      '.coach-optional{margin-top:16px}.coach-optional button{width:100%}' +
      '.coach-hidden-tools{display:none!important}' +
      '.coach-time-row{display:flex;justify-content:space-between;gap:12px;align-items:center;margin:10px 0;padding:10px 12px;border-radius:10px;background:rgba(255,255,255,.04)}' +
      '.coach-guided-card{margin:14px 0;padding:16px;border-radius:16px;background:rgba(23,185,120,.08);border:1px solid rgba(23,185,120,.34)}' +
      '.coach-guided-card .guided-head{display:flex;justify-content:space-between;gap:10px;align-items:center;margin-bottom:10px}.coach-guided-card .guided-head strong{font-size:1rem}' +
      '.coach-guided-block{padding:11px 12px;margin:8px 0;border-radius:11px;background:rgba(255,255,255,.05)}.coach-guided-block small{display:block;opacity:.72;margin-bottom:4px}.coach-guided-block strong{display:block;line-height:1.45}' +
      '.coach-guided-map{margin-top:10px}.coach-guided-map summary{cursor:pointer;font-weight:700}.coach-guided-map-row{display:grid;grid-template-columns:44px 1fr;gap:8px;padding:7px 0;border-bottom:1px solid rgba(255,255,255,.06)}.coach-guided-map-row.active{font-weight:700}' +
      '@media(max-width:760px){.tef-coach-progress,.coach-metrics{grid-template-columns:1fr}.coach-hints{grid-template-columns:1fr}}';
    document.head.appendChild(st);
  }

  function renderPanel(){
    const c=S();
    const status=$('#tefCoachStatus');
    const start=$('#startTefCoach');
    const reset=$('#resetTefCoach');
    const diff=$('#tefCoachDifficulty');
    if(!status || !start) return;
    if(c.active){
      const st=currentStage();
      status.textContent='Em curso: ' + st.label + ' · Speaking Section ' + st.section;
      start.textContent='CONTINUAR TEF AI COACH';
    }else if(c.completedAt){
      status.textContent='Ciclo concluído. Podes rever erros ou iniciar outro.';
      start.textContent='VER RESULTADO';
    }else{
      status.textContent='Ainda não iniciado.';
      start.textContent='COMEÇAR TREINO TEF DE HOJE';
    }
    if(reset) reset.classList.toggle('hidden', !(c.active || c.completedAt));
    if(diff){
      diff.value=c.difficulty || 'B1';
      diff.disabled=Boolean(c.active);
    }
  }

  async function startNew(){
    const c=fresh();
    c.id='coach_'+Date.now();
    c.active=true;
    c.difficulty=$('#tefCoachDifficulty')?.value || 'B1';
    c.startedAt=new Date().toISOString();
    state.tefAiCoach=c;
    persist();
    const w=workspace();
    w.className='panel exercise-panel sim-loading';
    w.innerHTML='<span class="loader"></span><strong>A preparar o teu TEF AI COACH · '+escapeHtml(c.difficulty)+'</strong><small>Crio duas tarefas de treino e duas tarefas novas para a prova final.</small>';
    try{
      const out=await api('/api/generate-speaking-cycle',{difficulty:c.difficulty});
      S().package=out.cycle;
      persist();
      renderStage(stages[0], true);
    }catch(e){
      S().active=false;
      persist();
      w.innerHTML='<div class="feedback feedback-retry"><strong>Não consegui criar o treino.</strong><p>'+escapeHtml(friendlyError(e))+'</p></div>';
      toast(friendlyError(e),'error');
    }
  }

  function progressHtml(stage){
    const group = stage.mode === 'full' ? 0 : stage.mode === 'minimal' ? 1 : 2;
    const names=['1 · COM AJUDA','2 · AJUDA MÍNIMA','3 · SEM AJUDA'];
    return '<div class="tef-coach-progress">'+names.map((x,i)=>'<div class="'+(i===group?'active':'')+'">'+x+'</div>').join('')+'</div>';
  }

  function targetSeconds(section){
    return section==='A'?300:600;
  }

  function guidedPlan(task){
    const plan=Array.isArray(task?.guidedPlan)?task.guidedPlan.filter(x=>x?.sayFr):[];
    if(plan.length)return plan;
    const support=Array.isArray(task?.support)?task.support:[];
    return support.map((x,i)=>({
      phasePt:i===0?'Abertura':'Continuar conversa',
      goalPt:x.purposePt||'Usar esta estrutura na conversa',
      sayFr:x.fr||'',
      sayPt:x.pt||'',
      pronunciationPt:x.pronunciationPt||'',
      listenForPt:'Ouve a resposta e identifica a informação principal antes de continuar.',
      bridgeFr:i===0?'Très bien, merci.':'D’accord, merci.',
      bridgePt:i===0?'Muito bem, obrigado.':'Está bem, obrigado.',
      rescueFr:x.fr||''
    }));
  }

  function guideIndex(rt,plan){
    if(!plan.length)return 0;
    return Math.max(0,Math.min(Number(rt.guideStep)||0,plan.length-1));
  }

  function renderGuidedStep(stage,task,rt){
    if(stage.mode!=='full')return;
    const holder=$('#coachGuidedStep');
    if(!holder)return;
    const plan=guidedPlan(task);
    if(!plan.length){
      holder.innerHTML='<div class="feedback">Este ciclo antigo não tem ainda o mapa completo. Inicia um novo ciclo para receber o guia passo a passo.</div>';
      return;
    }
    const idx=guideIndex(rt,plan),step=plan[idx];
    const done=Boolean(rt.guideCompleted);
    holder.innerHTML='<div class="coach-guided-card">'+
      '<div class="guided-head"><div><div class="small-label">GUIA DA CONVERSA · '+(stage.section==='A'?'5 MIN':'10 MIN')+'</div><strong>'+(done?'MAPA COMPLETO — fecha naturalmente a conversa':'PASSO '+(idx+1)+'/'+plan.length+' · '+escapeHtml(step.phasePt||''))+'</strong></div><span class="badge">'+Math.round(((done?plan.length:idx)/plan.length)*100)+'%</span></div>'+
      (done
        ? '<div class="coach-guided-block"><small>AGORA</small><strong>Já percorreste todos os passos. Faz uma reação final natural e termina a secção quando estiveres pronto.</strong></div>'
        : '<div class="coach-guided-block"><small>1 · O QUE FAZER AGORA</small><strong>'+escapeHtml(step.goalPt||'Continua a conversa.')+'</strong></div>'+
          '<div class="coach-guided-block"><small>2 · PODES DIZER ISTO</small><strong lang="fr">'+escapeHtml(step.sayFr||'')+'</strong>'+
            (step.pronunciationPt?'<span class="pronunciation-cue"><b>Lê assim:</b> '+escapeHtml(step.pronunciationPt)+'</span>':'')+
            (step.sayPt?'<p>'+escapeHtml(step.sayPt)+'</p>':'')+
            '<button id="coachGuideSayAudio" class="secondary-btn compact">▶ OUVIR ESTE TURNO</button></div>'+
          '<div class="coach-guided-block"><small>3 · QUANDO ELE RESPONDER, OUVE ISTO</small><strong>'+escapeHtml(step.listenForPt||'A informação principal da resposta.')+'</strong></div>'+
          '<div class="coach-guided-block"><small>4 · REAGE E LIGA À PRÓXIMA IDEIA</small><strong lang="fr">'+escapeHtml(step.bridgeFr||'D’accord, merci.')+'</strong>'+(step.bridgePt?'<p>'+escapeHtml(step.bridgePt)+'</p>':'')+'<button id="coachGuideBridgeAudio" class="secondary-btn compact">▶ OUVIR LIGAÇÃO</button></div>'+
          '<div class="coach-guided-block"><small>5 · SE BLOQUEARES</small><strong lang="fr">'+escapeHtml(step.rescueFr||step.sayFr||'')+'</strong></div>')+
      '<details class="coach-guided-map"><summary>Ver mapa completo da conversa</summary>'+
        plan.map((x,i)=>'<div class="coach-guided-map-row '+(i===idx&&!done?'active':'')+'"><span>'+(i+1)+'</span><span>'+escapeHtml(x.phasePt||'Passo')+' — '+escapeHtml(x.goalPt||'')+'</span></div>').join('')+
      '</details></div>';
    if($('#coachGuideSayAudio'))$('#coachGuideSayAudio').onclick=()=>playStudyPhrase(step.sayFr,'neutral',$('#coachGuideSayAudio'));
    if($('#coachGuideBridgeAudio'))$('#coachGuideBridgeAudio').onclick=()=>playStudyPhrase(step.bridgeFr,'neutral',$('#coachGuideBridgeAudio'));
  }

  function startStageClock(stage,rt){
    clearInterval(stageClockTimer);
    const target=targetSeconds(stage.section);
    const tick=()=>{
      const el=$('#coachStageClock');
      if(!el)return;
      const elapsed=Math.max(0,Math.floor((Date.now()-rt.startedAt)/1000));
      el.textContent=formatTime(elapsed)+' / '+formatTime(target);
    };
    tick();
    stageClockTimer=setInterval(tick,1000);
  }

  function renderSupport(stage, task, rt){
    if(stage.mode === 'final') return '';
    if(stage.mode === 'full'){
      return '<div class="assisted-help-card"><h4>EXAME GUIADO — EU DIGO-TE O QUE FAZER EM CADA PASSO</h4>'+
        '<div class="assisted-translation"><strong>Consigne em português:</strong><br>'+escapeHtml(task.promptPt||'')+'</div>'+
        (task.roadmapPt?'<p><strong>Estrutura completa:</strong> '+escapeHtml(task.roadmapPt)+'</p>':'')+
        '<div id="coachGuidedStep"></div><div id="coachDemandHint"></div></div>';
    }
    return '<div class="assisted-help-card"><h4>AJUDA MÍNIMA</h4><p>Faz primeiro sozinho. Se bloqueares, carrega <strong>PRECISO DE UMA PISTA</strong>. A ajuda abre por níveis, não entrega logo a resposta.</p><div id="coachDemandHint"></div></div>';
  }

  function renderConversation(stage, rt){
    const box=$('#coachConversation');
    if(!box) return;
    if(!rt.conversation.length){
      box.innerHTML='<div class="conversation-empty">'+(stage.mode==='final'?'Começa quando estiveres pronto. Durante esta fase não aparece qualquer ajuda.':'Fala em francês. O tutor responde como interlocutor real e só corrige erros importantes.')+'</div>';
      return;
    }
    box.innerHTML=rt.conversation.map((x,i)=>{
      if(stage.mode==='final'){
        return x.role==='candidate'
          ? '<div class="bubble candidate"><span>Tu</span>Resposta enviada</div>'
          : '<div class="bubble examiner"><span>Examinador AI</span>Resposta áudio reproduzida</div>';
      }
      if(x.role==='candidate') return '<div class="bubble candidate"><span>Tu</span>'+escapeHtml(x.text||'')+'</div>';
      const options=stage.mode==='full' && Array.isArray(x.responseOptions) ? x.responseOptions : [];
      return '<div class="bubble examiner"><span>Interlocutor AI</span>'+escapeHtml(x.text||'')+
        (stage.mode==='full' && x.replyPt ? '<div class="assisted-help-card"><strong>Em português:</strong><p>'+escapeHtml(x.replyPt)+'</p>'+(x.helpPt?'<p><strong>Próximo passo:</strong> '+escapeHtml(x.helpPt)+'</p>':'')+
          (options.length?'<div class="support-phrase-list">'+options.map((o,j)=>'<div class="support-phrase"><button class="mini-audio coach-option-audio" data-ci="'+i+'" data-oi="'+j+'">🔊</button><div><span class="support-purpose">'+escapeHtml(o.purposePt||'Opção')+'</span><strong lang="fr">'+escapeHtml(o.fr||'')+'</strong><small>'+escapeHtml(o.pt||'')+'</small></div></div>').join('')+'</div>':'')+
          '</div>':'')+
        '</div>';
    }).join('');
    $$('.coach-option-audio',box).forEach(btn=>{
      const item=rt.conversation[Number(btn.dataset.ci)]?.responseOptions?.[Number(btn.dataset.oi)];
      if(item) btn.onclick=()=>playStudyPhrase(item.fr,'neutral',btn);
    });
    box.scrollTop=box.scrollHeight;
  }

  function renderStage(stage, reset=false){
    stopMedia();
    submitting=false;
    const c=S();
    const task=taskFor(stage);
    if(!task){ toast('Não encontrei a tarefa desta etapa.','error'); return; }
    c.stageIndex=stages.findIndex(x=>x.id===stage.id);
    c.active=true;
    const rt=runtime(stage, reset);
    persist();
    const info=modeInfo(stage.mode);
    const w=workspace();
    w.className='panel exercise-panel';
    w.innerHTML=
      '<div class="cycle-stage-head"><div><div class="cycle-stage-kicker">TEF AI COACH</div><h3>SPEAKING · SECTION '+stage.section+'</h3></div><span class="badge">'+escapeHtml(c.difficulty)+'</span></div>' +
      progressHtml(stage) +
      '<div class="tef-coach-mode '+info.cls+'"><strong>'+info.title+'</strong><span>'+info.subtitle+'</span></div>' +
      '<div class="coach-time-row"><span>RITMO DA CONVERSA</span><strong id="coachStageClock">00:00 / '+formatTime(targetSeconds(stage.section))+'</strong></div>' +
      '<div class="task-card"><h4>Consigne</h4><div class="task-prompt">'+escapeHtml(task.promptFr||'')+'</div>' +
        (stage.mode==='full' && task.prepTipPt?'<p><small><strong>Guia:</strong> '+escapeHtml(task.prepTipPt)+'</small></p>':'')+
      '</div>' +
      renderSupport(stage,task,rt) +
      '<div id="coachConversation" class="conversation-log"></div>' +
      '<div id="coachIntervention"></div>' +
      '<div class="recording-controls">' +
        '<button id="coachTurnStart" class="record-btn">● FALAR / RESPONDER</button>' +
        '<button id="coachTurnStop" class="stop-btn" disabled>■ TERMINEI</button>' +
        (stage.mode!=='final'?'<button id="coachNeedHelp" class="secondary-btn">PRECISO DE UMA PISTA</button>':'') +
        '<button id="coachFinishStage" class="secondary-btn">TERMINAR SECTION '+stage.section+'</button>' +
      '</div>' +
      '<div id="coachStatus" class="small-label">'+
        (stage.mode==='final'?'Sem ajuda. Fala normalmente e carrega TERMINEI quando acabares a resposta.':'Fala sem pressa. A correção só aparece quando realmente ajudar.')+
      '</div>';

    renderConversation(stage,rt);
    renderGuidedStep(stage,task,rt);
    startStageClock(stage,rt);
    const support=Array.isArray(task.support)?task.support:[];
    $$('.coach-support-audio',w).forEach(btn=>{
      const x=support[Number(btn.dataset.i)];
      if(x) btn.onclick=()=>playStudyPhrase(x.fr,'neutral',btn);
    });
    $('#coachTurnStart').onclick=()=>startRecording({type:'turn',stageId:stage.id});
    $('#coachTurnStop').onclick=finishRecording;
    $('#coachFinishStage').onclick=()=>finishStage(stage);
    if($('#coachNeedHelp')) $('#coachNeedHelp').onclick=()=>showDemandHelp(stage,task,rt);
    if(rt.pending) renderIntervention(stage,rt);
    setTimeout(()=>w.scrollIntoView({behavior:'smooth',block:'start'}),60);
  }

  function showDemandHelp(stage,task,rt){
    const box=$('#coachDemandHint');
    const plan=guidedPlan(task);
    if(plan.length){
      const idx=stage.mode==='full'?guideIndex(rt,plan):Math.min(rt.candidateTurns.length,plan.length-1);
      const x=plan[idx];
      rt.helpLevel=(rt.helpLevel||0)+1;
      if(rt.helpLevel>3)rt.helpLevel=1;
      S().helpTaps++;
      persist();
      const words=String(x.sayFr||'').split(/\s+/);
      if(rt.helpLevel===1){
        box.innerHTML='<div class="coach-hint-box"><strong>Pista 1/3 · palavra:</strong> <span lang="fr">'+escapeHtml(words[0]||'')+'</span></div>';
      }else if(rt.helpLevel===2){
        box.innerHTML='<div class="coach-hint-box"><strong>Pista 2/3 · começa assim:</strong> <span lang="fr">'+escapeHtml(words.slice(0,4).join(' '))+'…</span></div>';
      }else{
        box.innerHTML='<div class="coach-hint-box"><strong>Pista 3/3 · turno completo:</strong><strong lang="fr">'+escapeHtml(x.sayFr||'')+'</strong>'+
          (x.pronunciationPt?'<small class="pronunciation-cue"><b>Lê assim:</b> '+escapeHtml(x.pronunciationPt)+'</small>':'')+
          (x.sayPt?'<p>'+escapeHtml(x.sayPt)+'</p>':'')+'<button id="coachDemandAudio" class="secondary-btn compact">▶ OUVIR</button></div>';
        $('#coachDemandAudio').onclick=()=>playStudyPhrase(x.sayFr,'neutral',$('#coachDemandAudio'));
      }
      return;
    }
    toast('Não tenho uma pista pronta para esta tarefa.','error');
  }

  async function startRecording(ctx){
    if(submitting || recorder?.state==='recording') return;
    if(!navigator.mediaDevices?.getUserMedia){ toast('Microfone indisponível neste browser.','error'); return; }
    try{
      stream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true}});
      const mime=MediaRecorder.isTypeSupported('audio/webm;codecs=opus')?'audio/webm;codecs=opus':'audio/webm';
      recorder=new MediaRecorder(stream,{mimeType:mime});
      chunks=[];
      recordContext=ctx;
      recorder.ondataavailable=e=>{ if(e.data.size) chunks.push(e.data); };
      recorder.start(250);
      const start=ctx.type==='turn'?$('#coachTurnStart'):$('#coachCorrectionStart');
      const stop=ctx.type==='turn'?$('#coachTurnStop'):$('#coachCorrectionStop');
      const status=ctx.type==='turn'?$('#coachStatus'):$('#coachCorrectionStatus');
      if(start){ start.disabled=true; start.textContent='● A OUVIR-TE…'; }
      if(stop) stop.disabled=false;
      if(status) status.textContent='A ouvir-te… quando terminares toda a frase, carrega TERMINEI.';
      hardStopTimer=setTimeout(()=>{ if(recorder?.state==='recording') finishRecording(); },120000);
    }catch(e){
      toast('Não consegui abrir o microfone: '+e.message,'error');
    }
  }

  async function finishRecording(){
    if(submitting || !recorder || recorder.state!=='recording') return;
    submitting=true;
    clearTimeout(hardStopTimer); hardStopTimer=null;
    const ctx=recordContext;
    const dataUrl=await new Promise(resolve=>{
      recorder.onstop=()=>{
        const blob=new Blob(chunks,{type:recorder.mimeType});
        const reader=new FileReader();
        reader.onload=()=>resolve(reader.result);
        reader.readAsDataURL(blob);
        if(stream) stream.getTracks().forEach(t=>t.stop());
        stream=null;
      };
      recorder.stop();
    });
    recorder=null;
    chunks=[];
    try{
      if(ctx?.type==='correction') await handleCorrectionAudio(ctx,dataUrl);
      else await handleTurnAudio(ctx,dataUrl);
    }finally{
      submitting=false;
      recordContext=null;
    }
  }

  function stopMedia(){
    clearTimeout(hardStopTimer); hardStopTimer=null;
    clearInterval(stageClockTimer); stageClockTimer=null;
    if(recorder?.state==='recording'){ try{recorder.stop();}catch{} }
    if(stream){ try{stream.getTracks().forEach(t=>t.stop());}catch{} }
    recorder=null; stream=null; chunks=[]; recordContext=null;
  }

  async function transcribe(dataUrl){
    const out=await api('/api/transcribe',{audioDataUrl:dataUrl});
    return String(out.transcript||'').trim();
  }

  function shouldIntervene(stage,coach){
    if(stage.mode==='final' || !coach?.intervene || !coach.correctedFr) return false;
    if(coach.confidence==='low') return false;
    if(stage.mode==='minimal') return coach.priority==='high';
    return coach.priority==='high' || coach.priority==='medium';
  }

  function storeCoachIssue(stage,coach){
    const c=S();
    const item={
      id:'m_'+Date.now()+'_'+Math.random().toString(36).slice(2,6),
      at:new Date().toISOString(),
      section:stage.section,
      mode:stage.mode,
      issueType:coach.issueType||'clarity',
      whyPt:coach.whyPt||'',
      originalFr:coach.originalFr||'',
      correctedFr:coach.correctedFr||'',
      meaningPt:coach.meaningPt||'',
      pronunciationPt:coach.pronunciationPt||'',
      attempts:0,
      mastered:false
    };
    c.mistakes.push(item);
    const vocab=Array.isArray(coach.vocab)?coach.vocab:[];
    const add=[];
    if(item.correctedFr) add.push({fr:item.correctedFr,pt:item.meaningPt,pronunciationPt:item.pronunciationPt,source:'tef-ai-coach-live'});
    for(const v of vocab) if(v?.fr) add.push({fr:v.fr,pt:v.pt||'',pronunciationPt:v.pronunciationPt||'',source:'tef-ai-coach-live'});
    if(add.length) addVocab(add);
    persist();
    return item;
  }

  async function handleTurnAudio(ctx,dataUrl){
    const stage=stages.find(x=>x.id===ctx?.stageId) || currentStage();
    const rt=runtime(stage);
    const status=$('#coachStatus');
    try{
      if(status) status.textContent='A transcrever a tua resposta…';
      const candidateText=await transcribe(dataUrl);
      if(!candidateText) throw new Error('Não consegui perceber a resposta. Repete o turno.');
      rt.candidateTurns.push(candidateText);
      rt.conversation.push({role:'candidate',text:candidateText});
      persist();
      renderConversation(stage,rt);
      if(status) status.textContent='O TEF AI COACH está a analisar sem interromper por erros pequenos…';
      const history=rt.conversation.slice(-12).map(x=>({role:x.role,text:x.text}));
      const out=await api('/api/tef-coach-turn',{
        section:stage.section,
        task:taskFor(stage),
        history,
        candidateText,
        coachMode:stage.mode,
        nextGuideStep:stage.mode==='full'?guidedPlan(taskFor(stage))[Math.min((rt.guideStep||0)+1,guidedPlan(taskFor(stage)).length-1)]||null:null
      });
      const turn=out.turn;
      if(shouldIntervene(stage,turn.coach)){
        const issue=storeCoachIssue(stage,turn.coach);
        rt.pending={turn,issueId:issue.id,attempts:0};
        persist();
        renderIntervention(stage,rt);
        if(status) status.textContent='Correção rápida: resolve esta frase e voltamos automaticamente à conversa.';
      }else{
        await continueWithExaminer(stage,rt,turn);
      }
    }catch(e){
      if(status) status.textContent='Não consegui processar este turno. Podes tentar novamente.';
      toast(friendlyError(e),'error');
    }finally{
      const start=$('#coachTurnStart'),stop=$('#coachTurnStop');
      if(start){ start.disabled=false; start.textContent='● FALAR / RESPONDER'; }
      if(stop) stop.disabled=true;
    }
  }

  function renderIntervention(stage,rt,lastEval=null){
    const pending=rt.pending;
    const coach=pending?.turn?.coach;
    const box=$('#coachIntervention');
    if(!box || !coach) return;
    box.innerHTML=
      '<div class="coach-intervention"><div class="small-label">CORREÇÃO RÁPIDA · 15–45 s</div><h4>'+escapeHtml(coach.whyPt||'Vamos corrigir uma estrutura importante antes de continuar.')+'</h4>' +
      (coach.originalFr?'<p><strong>Tu disseste:</strong> <span lang="fr">'+escapeHtml(coach.originalFr)+'</span></p>':'') +
      '<div class="coach-hints">' +
        '<button id="coachHintWord" class="secondary-btn">1 · PALAVRA</button>' +
        '<button id="coachHintStart" class="secondary-btn">2 · COMEÇO</button>' +
        '<button id="coachHintFull" class="secondary-btn">3 · FRASE</button>' +
      '</div>' +
      '<div id="coachHintReveal"></div>' +
      (lastEval?'<div class="feedback '+(lastEval.achieved?'feedback-correct':'feedback-retry')+'"><strong>'+(lastEval.achieved?'Boa. Estrutura aceite.':'Ainda não ficou estável.')+'</strong><p>'+escapeHtml(lastEval.feedbackPt||'')+'</p>'+(lastEval.correctedFr?'<p lang="fr"><strong>'+escapeHtml(lastEval.correctedFr)+'</strong></p>':'')+'</div>':'') +
      '<div class="recording-controls">' +
        '<button id="coachCorrectionStart" class="record-btn">● REPETIR AGORA</button>' +
        '<button id="coachCorrectionStop" class="stop-btn" disabled>■ TERMINEI</button>' +
        (pending.attempts>=2?'<button id="coachSkipCorrection" class="secondary-btn">GUARDAR PARA REVISÃO E CONTINUAR</button>':'') +
      '</div><div id="coachCorrectionStatus" class="small-label">Tenta primeiro sem veres a frase completa. Usa as pistas só se precisares.</div></div>';
    $('#coachHintWord').onclick=()=>{
      S().helpTaps++; persist();
      $('#coachHintReveal').innerHTML='<div class="coach-hint-box"><strong>Palavra-chave:</strong> <span lang="fr">'+escapeHtml(coach.hintWord||'—')+'</span></div>';
    };
    $('#coachHintStart').onclick=()=>{
      S().helpTaps++; persist();
      $('#coachHintReveal').innerHTML='<div class="coach-hint-box"><strong>Começa assim:</strong> <span lang="fr">'+escapeHtml(coach.hintStart||'—')+'</span></div>';
    };
    $('#coachHintFull').onclick=()=>{
      S().helpTaps++; persist();
      $('#coachHintReveal').innerHTML='<div class="coach-hint-box"><strong lang="fr">'+escapeHtml(coach.correctedFr||'')+'</strong>' +
        (coach.pronunciationPt?'<small class="pronunciation-cue"><b>Lê assim:</b> '+escapeHtml(coach.pronunciationPt)+'</small>':'') +
        (coach.meaningPt?'<p>'+escapeHtml(coach.meaningPt)+'</p>':'') +
        '<button id="coachCorrectionAudio" class="secondary-btn compact">▶ OUVIR</button></div>';
      $('#coachCorrectionAudio').onclick=()=>playStudyPhrase(coach.correctedFr,'neutral',$('#coachCorrectionAudio'));
    };
    $('#coachCorrectionStart').onclick=()=>startRecording({type:'correction',stageId:stage.id});
    $('#coachCorrectionStop').onclick=finishRecording;
    if($('#coachSkipCorrection')) $('#coachSkipCorrection').onclick=()=>skipCorrection(stage,rt);
  }

  async function handleCorrectionAudio(ctx,dataUrl){
    const stage=stages.find(x=>x.id===ctx?.stageId) || currentStage();
    const rt=runtime(stage);
    const pending=rt.pending;
    if(!pending) return;
    const coach=pending.turn.coach;
    const status=$('#coachCorrectionStatus');
    try{
      if(status) status.textContent='A verificar a repetição…';
      const learnerTranscript=await transcribe(dataUrl);
      if(!learnerTranscript) throw new Error('Não consegui perceber a repetição.');
      const out=await api('/api/evaluate-speaking-drill',{
        section:stage.section,
        skillId:'live-tef-correction',
        modelFr:coach.correctedFr,
        learnerTranscript
      });
      pending.attempts=(pending.attempts||0)+1;
      const ev=out.evaluation;
      const item=S().mistakes.find(x=>x.id===pending.issueId);
      if(ev.achieved){
        if(item){ item.mastered=true; item.attempts=pending.attempts; }
        S().correctedCount++;
        persist();
        if(status) status.textContent='Estrutura corrigida. A regressar à conversa…';
        await continueWithExaminer(stage,rt,pending.turn);
        rt.pending=null;
        persist();
        renderStage(stage,false);
      }else{
        if(ev.correctedFr) coach.correctedFr=ev.correctedFr;
        if(ev.pronunciationPt) coach.pronunciationPt=ev.pronunciationPt;
        if(item) item.attempts=pending.attempts;
        persist();
        renderIntervention(stage,rt,ev);
      }
    }catch(e){
      if(status) status.textContent='Falha ao verificar. Podes repetir.';
      toast(friendlyError(e),'error');
    }finally{
      const start=$('#coachCorrectionStart'),stop=$('#coachCorrectionStop');
      if(start){ start.disabled=false; start.textContent='● REPETIR AGORA'; }
      if(stop) stop.disabled=true;
    }
  }

  async function skipCorrection(stage,rt){
    const pending=rt.pending;
    if(!pending) return;
    const item=S().mistakes.find(x=>x.id===pending.issueId);
    if(item){ item.mastered=false; item.attempts=pending.attempts||0; }
    await continueWithExaminer(stage,rt,pending.turn);
    rt.pending=null;
    persist();
    renderStage(stage,false);
  }

  async function continueWithExaminer(stage,rt,turn){
    rt.conversation.push({
      role:'examiner',
      text:turn.replyFr,
      replyPt:stage.mode==='full'?turn.replyPt:'',
      helpPt:stage.mode==='full'?turn.helpPt:'',
      responseOptions:stage.mode==='full'?(turn.responseOptions||[]):[]
    });
    persist();
    renderConversation(stage,rt);
    const status=$('#coachStatus');
    if(status) status.textContent='Interlocutor a responder…';
    await playStudyPhrase(turn.replyFr,'man');
    if(stage.mode==='full'){
      const plan=guidedPlan(taskFor(stage));
      if(plan.length){
        if((rt.guideStep||0) >= plan.length-1) rt.guideCompleted=true;
        else rt.guideStep=(rt.guideStep||0)+1;
        rt.helpLevel=0;
        persist();
        renderGuidedStep(stage,taskFor(stage),rt);
      }
    }
    if(status) status.textContent=stage.mode==='final'?'Tua vez. Sem ajuda.':stage.mode==='full'?'Tua vez. Segue o próximo passo do guia.':'Tua vez. Continua a conversa.';
  }

  async function finishStage(stage){
    const rt=runtime(stage);
    if(rt.pending){ toast('Termina primeiro a correção rápida.','error'); return; }
    if(stage.mode==='full' && guidedPlan(taskFor(stage)).length && !rt.guideCompleted){
      const plan=guidedPlan(taskFor(stage));
      const left=Math.max(1,plan.length-(rt.guideStep||0));
      toast('Ainda faltam '+left+' passos do guia. Completa a conversa para treinares a secção inteira.','error');
      return;
    }
    if(!rt.candidateTurns.length){ toast('Fala pelo menos uma vez antes de terminar esta secção.','error'); return; }
    stopMedia();
    const w=workspace();
    w.innerHTML='<div class="panel-head"><h3>A avaliar esta etapa</h3><span class="loader"></span></div><p>'+(stage.mode==='final'?'Avaliação da prova sem ajuda.':'Feedback de treino — não é nota oficial.')+'</p>';
    try{
      const transcript=rt.candidateTurns.join('\n');
      const durationSeconds=Math.max(1,Math.round((Date.now()-rt.startedAt)/1000));
      let evaluation,raters=[];
      if(stage.mode==='final'){
        const out=await api('/api/evaluate-speaking-multi',{section:stage.section,task:taskFor(stage),transcript,durationSeconds});
        evaluation=out.evaluation; raters=out.raters||[];
      }else{
        const out=await api('/api/evaluate-speaking',{section:stage.section,task:taskFor(stage),transcript,durationSeconds});
        evaluation=out.evaluation;
      }
      rt.completed=true;
      rt.evaluation=evaluation;
      S().results[stage.id]={evaluation,raters,transcript,durationSeconds,at:new Date().toISOString()};
      state.speakingAttempts.push({
        section:stage.section,
        overall:evaluation.overall,
        readinessBand:evaluation.readinessBand,
        criteria:evaluation.criteria,
        at:new Date().toISOString(),
        assisted:stage.mode!=='final',
        cycleStage:'tefCoach-'+stage.id
      });
      logHistory('TEF AI Coach','Section '+stage.section+' · '+stage.label,(evaluation.overall||0)+'/100 · '+bandLabel(evaluation.readinessBand));
      persist();
      renderStageResult(stage,evaluation);
    }catch(e){
      w.innerHTML='<div class="feedback feedback-retry"><strong>Falha na avaliação.</strong><p>'+escapeHtml(friendlyError(e))+'</p><button id="coachRetryEval" class="primary-btn">Tentar novamente</button></div>';
      $('#coachRetryEval').onclick=()=>finishStage(stage);
    }
  }

  function nextStage(stage){
    const idx=stages.findIndex(x=>x.id===stage.id);
    if(idx<0 || idx===stages.length-1){ finishCoach(); return; }
    S().stageIndex=idx+1;
    persist();
    renderStage(stages[idx+1],true);
  }

  function renderStageResult(stage,evaluation){
    const w=workspace();
    w.className='panel exercise-panel';
    w.innerHTML='<div id="speakingFeedback"></div>' +
      '<div class="cycle-next-box"><div><strong>Próximo: '+escapeHtml(stage.next)+'</strong><small>'+
      (stage.mode==='full'?'Agora repetes exatamente a mesma tarefa com menos ajuda.':stage.mode==='minimal'?'Mantemos o que aprendeste e avançamos.':'Continuamos a prova sem ajuda.')+
      '</small></div><button id="coachNextStage" class="primary-btn">AVANÇAR</button></div>';
    renderSpeakingEvaluation(evaluation,w);
    $('#coachNextStage').onclick=()=>nextStage(stage);
  }

  function finishCoach(){
    stopMedia();
    const c=S();
    c.active=false;
    c.completedAt=new Date().toISOString();
    persist();
    renderSummary();
  }

  function score(id){
    return Number(S().results[id]?.evaluation?.overall)||0;
  }

  function renderSummary(){
    const c=S(),w=workspace();
    const unresolved=c.mistakes.filter(x=>!x.mastered).length;
    w.className='panel exercise-panel';
    w.innerHTML=
      '<div class="cycle-stage-head"><div><div class="cycle-stage-kicker">TEF AI COACH · CONCLUÍDO</div><h3>Treino → ajuda mínima → prova sem ajuda</h3></div><span class="badge">GUARDADO</span></div>' +
      '<div class="coach-metrics">' +
        '<div><span>FINAL A</span><strong>'+score('finalA')+'/100</strong></div>' +
        '<div><span>FINAL B</span><strong>'+score('finalB')+'/100</strong></div>' +
        '<div><span>CORREÇÕES DOMINADAS</span><strong>'+c.correctedCount+'</strong></div>' +
        '<div><span>PARA REVER</span><strong>'+unresolved+'</strong></div>' +
      '</div>' +
      '<div class="mock-rule"><strong>O que o sistema fez:</strong> guardou automaticamente as estruturas e palavras importantes no teu vocabulário/revisão. As notas são estimativas internas de treino, não resultados oficiais do TEF.</div>' +
      '<div class="hero-actions"><button id="coachReviewMistakes" class="secondary-btn">REVER ERROS E VOCABULÁRIO</button><button id="coachOpenPlan" class="primary-btn">ABRIR PLANO AI</button><button id="coachNewCycle" class="secondary-btn">NOVO CICLO</button></div>';
    $('#coachReviewMistakes').onclick=renderReview;
    $('#coachOpenPlan').onclick=()=>navigate('plan');
    $('#coachNewCycle').onclick=()=>{ state.tefAiCoach=fresh(); persist(); renderPanel(); workspace().innerHTML='<div class="empty-icon">AI</div><h3>Pronto para um novo ciclo.</h3><p>Carrega COMEÇAR TREINO TEF DE HOJE.</p>'; };
  }

  function renderReview(){
    const c=S(),w=workspace();
    const items=c.mistakes.slice().reverse();
    w.className='panel exercise-panel';
    w.innerHTML='<div class="cycle-stage-head"><div><div class="cycle-stage-kicker">REVISÃO AUTOMÁTICA</div><h3>Erros e frases que realmente te bloquearam</h3></div><span class="badge">'+items.length+' ITENS</span></div>' +
      (items.length?'<div class="model-lines">'+items.map((x,i)=>'<div class="model-line"><span class="support-purpose">'+escapeHtml(x.issueType||'correção')+' · Section '+escapeHtml(x.section)+'</span>' +
        (x.originalFr?'<small>Tu: '+escapeHtml(x.originalFr)+'</small>':'') +
        '<strong lang="fr">'+escapeHtml(x.correctedFr||'')+'</strong>' +
        (x.pronunciationPt?'<small class="pronunciation-cue"><b>Lê assim:</b> '+escapeHtml(x.pronunciationPt)+'</small>':'') +
        (x.meaningPt?'<small>'+escapeHtml(x.meaningPt)+'</small>':'') +
        '<button class="mini-audio coach-review-audio" data-i="'+i+'">🔊</button></div>').join('')+'</div>':'<div class="feedback">Não há erros prioritários guardados neste ciclo.</div>') +
      '<div class="hero-actions"><button id="coachBackSummary" class="secondary-btn">VOLTAR AO RESULTADO</button><button id="coachPlanFromReview" class="primary-btn">PLANO AI</button></div>';
    $$('.coach-review-audio',w).forEach(btn=>{
      const x=items[Number(btn.dataset.i)];
      if(x?.correctedFr) btn.onclick=()=>playStudyPhrase(x.correctedFr,'neutral',btn);
    });
    $('#coachBackSummary').onclick=renderSummary;
    $('#coachPlanFromReview').onclick=()=>navigate('plan');
  }

  function renderCoachLanding(){
    const w=workspace();
    if(!w) return;
    w.className='panel exercise-panel empty-state';
    w.innerHTML='<div class="empty-icon">AI</div><h3>TEF AI COACH</h3><p>Carrega <strong>COMEÇAR TREINO TEF DE HOJE</strong>. O sistema guia-te por ajuda → correção → repetição → exame sem ajuda.</p>';
  }

  function resume(){
    const c=S();
    if(!c.package){ startNew(); return; }
    if(!c.active && c.completedAt){ renderSummary(); return; }
    const stage=currentStage();
    renderStage(stage,false);
  }

  function hideOptionalTools(){
    const pathPanel=document.querySelector('#speakingPathOverview');
    const modePanel=document.querySelector('.speaking-mode-panel');
    const freeGrid=modePanel?.nextElementSibling;
    if(pathPanel) pathPanel.classList.add('coach-hidden-tools');
    if(modePanel) modePanel.classList.add('coach-hidden-tools');
    if(freeGrid?.classList?.contains('top-grid')) freeGrid.classList.add('coach-hidden-tools');
    const btn=$('#toggleSpeakingTools');
    if(btn){
      btn.onclick=()=>{
        const hidden=modePanel?.classList.contains('coach-hidden-tools');
        pathPanel?.classList.toggle('coach-hidden-tools',!hidden);
        modePanel?.classList.toggle('coach-hidden-tools',!hidden);
        freeGrid?.classList.toggle('coach-hidden-tools',!hidden);
        btn.textContent=hidden?'OCULTAR TREINO LIVRE':'ABRIR TREINO LIVRE (OPCIONAL)';
      };
    }
  }

  function wire(){
    injectStyles();
    renderPanel();
    hideOptionalTools();
    if(S().active || S().completedAt) setTimeout(resume,60);
    else setTimeout(renderCoachLanding,60);
    $('#startTefCoach')?.addEventListener('click',()=>{
      const c=S();
      if(c.active || c.completedAt) resume();
      else startNew();
    });
    $('#resetTefCoach')?.addEventListener('click',()=>{
      if(confirm('Recomeçar o TEF AI COACH? O histórico geral e o vocabulário guardado não serão apagados.')){
        stopMedia();
        state.tefAiCoach=fresh();
        persist();
        const w=workspace();
        w.className='panel exercise-panel empty-state';
        w.innerHTML='<div class="empty-icon">AI</div><h3>TEF AI COACH reiniciado.</h3><p>Escolhe a dificuldade e começa quando quiseres.</p>';
      }
    });
    $('.nav-item[data-page="speaking"]')?.addEventListener('click',()=>setTimeout(()=>{ renderPanel(); hideOptionalTools(); if(S().active||S().completedAt) resume(); else renderCoachLanding(); },60));
  }

  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',wire);
  else wire();
})();