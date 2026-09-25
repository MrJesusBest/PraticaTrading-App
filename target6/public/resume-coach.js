(() => {
  const safePages = new Set(['diagnostic','listening','speaking','plan','progress']);
  const todayKey = () => new Date().toLocaleDateString('en-CA');

  function persist(){
    try{ localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }catch{}
  }

  function recoverCompletedDiagnostic(){
    if(state.diagnostic?.completed) return;
    const history = Array.isArray(state.history) ? state.history : [];
    const evidence = history.some(h => h.kind === 'Diagnóstico' && /conclu/i.test(String(h.result||''))) ||
      Boolean(state.diagnostic?.completedAt) || Boolean(state.diagnostic?.speakingBaseline);
    if(evidence){
      state.diagnostic = {...state.diagnostic, active:false, completed:true};
      persist();
    }
  }

  function daysUntilExam(){
    const raw=String(state.settings?.examDate||'').trim();
    if(!raw) return null;
    const target=new Date(raw+'T12:00:00');
    if(Number.isNaN(target.getTime())) return null;
    const now=new Date(); now.setHours(12,0,0,0);
    return Math.ceil((target-now)/86400000);
  }

  function progressSignature(){
    const t=state.speakingTraining||{};
    return JSON.stringify({
      diagnostic:Boolean(state.diagnostic?.completed),
      diagnosticTotal:state.diagnostic?.total||0,
      listening:(state.listeningAttempts||[]).length,
      speaking:(state.speakingAttempts||[]).length,
      drills:t.total||0,
      guidedA:t.guided?.A||0,
      guidedB:t.guided?.B||0,
      vocab:(state.vocab||[]).length,
      planAt:state.plan?.generatedAt||'',
      exam:state.settings?.examDate||''
    });
  }

  function currentAction(){
    if(!state.diagnostic?.completed){
      if(state.diagnostic?.active && (state.diagnostic?.total>0 || state.diagnostic?.listeningDone)){
        return {
          page:'diagnostic',
          headline:'Retoma — não recomeces',
          summary:state.diagnostic.listeningDone
            ? 'O Listening do diagnóstico já está concluído. Falta continuar o nivelamento oral.'
            : 'Tens '+(state.diagnostic.total||0)+'/8 exercícios de Listening guardados. Continua a partir daí.'
        };
      }
      return {page:'diagnostic',headline:'Primeiro passo: diagnóstico único',summary:'Faz o diagnóstico uma vez. Depois o TARGET 6 deve continuar sempre a partir do teu progresso.'};
    }

    const drills=state.speakingTraining?.total||0;
    const l=typeof listeningAccuracy==='function' ? listeningAccuracy() : null;
    if(drills<12 || !(state.speakingAttempts||[]).length){
      return {page:'speaking',headline:'Foco principal: Speaking progressivo',summary:'Continua a construir frases, perguntas e interação. Não precisas repetir o diagnóstico.'};
    }
    if((state.listeningAttempts||[]).length<20 || (l!=null && l<75)){
      return {page:'listening',headline:'Foco de hoje: Listening + manutenção do Speaking',summary:'Trabalha compreensão sem ajuda e mantém um bloco curto de Speaking.'};
    }
    return {page:'plan',headline:'Segue o plano adaptativo',summary:'Mantém a combinação Speaking + Listening + revisão e usa o Full Mock só quando o gate interno estiver preparado.'};
  }

  function planDay(){
    if(!state.plan?.days?.length) return null;
    const generated=state.plan.generatedAt ? new Date(state.plan.generatedAt) : null;
    let index=0;
    if(generated && !Number.isNaN(generated.getTime())){
      const a=new Date(generated); a.setHours(12,0,0,0);
      const b=new Date(); b.setHours(12,0,0,0);
      index=Math.max(0,Math.floor((b-a)/86400000));
    }
    if(index>=state.plan.days.length) return null;
    return state.plan.days[index];
  }

  function fallbackTasks(){
    const a=currentAction(), day=planDay();
    if(day?.tasks?.length) return day.tasks.slice(0,3);
    if(a.page==='diagnostic'){
      return state.diagnostic?.listeningDone
        ? ['Completar 5 micro-drills de Speaking','Aplicar cada correção antes de avançar','Depois gerar o Plano AI']
        : ['Continuar o diagnóstico guardado','Não reiniciar exercícios já concluídos','Depois fazer o nivelamento oral'];
    }
    const drills=state.speakingTraining?.total||0;
    return [
      drills<12 ? '15–20 min de Speaking progressivo' : '15 min de Speaking guiado',
      '15–20 min de Listening sem ajuda',
      '10 min de revisão dos erros e vocabulário'
    ];
  }

  function render(){
    recoverCompletedDiagnostic();
    const action=currentAction();
    const coach=state.dailyCoach?.coach||{};
    const days=daysUntilExam();

    const guide=$('#dashboardGuideTitle');
    if(guide) guide.textContent=state.diagnostic?.completed
      ? 'Não repitas o diagnóstico. Continua sempre a partir do próximo passo indicado.'
      : state.diagnostic?.active ? 'O teu diagnóstico ficou guardado. Retoma de onde paraste.' : 'Começa pelo diagnóstico uma única vez; depois o progresso fica guardado.';

    const primary=$('#dashboardPrimaryAction');
    if(primary){
      primary.textContent=state.diagnostic?.completed ? 'Continuar de onde fiquei' : state.diagnostic?.active ? 'Retomar diagnóstico' : 'Começar diagnóstico';
      primary.onclick=()=>navigate(action.page);
    }

    const next=$('#nextAction');
    if(next) next.textContent=coach.summaryPt||action.summary;
    const nextBtn=$('#nextActionBtn');
    if(nextBtn) nextBtn.onclick=()=>navigate(coach.actionPage||action.page);

    const diagBtn=$('#startDiagnostic');
    const diagNote=$('#diagnosticStatusNote');
    if(diagBtn){
      if(state.diagnostic?.completed){
        diagBtn.textContent='Diagnóstico concluído — continuar treino';
        if(diagNote) diagNote.textContent='Concluído. Não precisas repetir o diagnóstico.';
      }else if(state.diagnostic?.active && (state.diagnostic?.total>0 || state.diagnostic?.listeningDone)){
        diagBtn.textContent='Retomar diagnóstico';
        if(diagNote) diagNote.textContent=state.diagnostic.listeningDone ? 'Listening concluído. Falta o nivelamento oral.' : 'Guardado: '+(state.diagnostic.total||0)+'/8 Listening concluídos.';
      }else if(diagNote){
        diagNote.textContent='O diagnóstico inicial é feito uma única vez.';
      }
    }

    if($('#coachHeadline')) $('#coachHeadline').textContent=coach.headline||action.headline;
    if($('#coachSummary')) $('#coachSummary').textContent=coach.summaryPt||action.summary;
    const tasks=Array.isArray(coach.tasks)&&coach.tasks.length ? coach.tasks : fallbackTasks();
    if($('#coachTasks')) $('#coachTasks').innerHTML=tasks.slice(0,3).map((x,i)=>'<div class="coach-task"><span>PASSO '+(i+1)+'</span><strong>'+escapeHtml(x)+'</strong></div>').join('');
    if($('#examCountdownBadge')) $('#examCountdownBadge').textContent=days==null ? 'DATA DO EXAME POR DEFINIR' : days>=0 ? days+' DIAS PARA O TEF' : 'DATA DO EXAME ULTRAPASSADA';
    if($('#coachContinueBtn')) $('#coachContinueBtn').onclick=()=>navigate(coach.actionPage||action.page);
    if($('#coachRefreshBtn')) $('#coachRefreshBtn').onclick=()=>refreshAI(true);
    if($('#coachMeta')) $('#coachMeta').textContent=state.dailyCoach?.generatedAt ? 'Conselho AI atualizado: '+new Date(state.dailyCoach.generatedAt).toLocaleString()+'.' : 'Conselho imediato baseado no teu progresso. A AI atualiza quando necessário.';

    if($('#examDateInput')) $('#examDateInput').value=state.settings?.examDate||'';
    if($('#examDateStatus')) $('#examDateStatus').textContent=days==null ? 'Ainda sem data exata. Define-a quando souberes.' : days>=0 ? 'Faltam '+days+' dias para a data definida.' : 'A data definida já passou — atualiza-a.';
  }

  async function refreshAI(force=false){
    if(!state.diagnostic?.completed){ render(); return; }
    const sig=progressSignature(), key=todayKey();
    if(!force && state.dailyCoach?.dateKey===key && state.dailyCoach?.signature===sig){ render(); return; }

    const btn=$('#coachRefreshBtn');
    if(btn) setBusy(btn,true,'A atualizar…');
    try{
      if(!health){
        const h=await fetch('/api/health').then(r=>r.json()).catch(()=>null);
        if(h) health=h;
      }
      if(!health?.aiConfigured){ render(); return; }

      const progress={
        diagnostic:state.diagnostic,
        listeningAccuracy:typeof listeningAccuracy==='function'?listeningAccuracy():null,
        listeningAttempts:(state.listeningAttempts||[]).slice(-20),
        speakingAverage:typeof speakingAverage==='function'?speakingAverage():null,
        speakingAttempts:(state.speakingAttempts||[]).slice(-10),
        speakingTraining:state.speakingTraining||null,
        recentHistory:(state.history||[]).slice(0,12),
        vocabDue:(state.vocab||[]).slice(-20)
      };
      const {plan}=await api('/api/coach-plan',{progress:{...progress,examDate:state.settings?.examDate||'',daysUntilExam:daysUntilExam()}});
      if(plan?.days?.length){
        state.plan={...plan,generatedAt:new Date().toISOString()};
        const first=plan.days[0];
        const action=currentAction();
        state.dailyCoach={
          dateKey:key,signature:sig,generatedAt:new Date().toISOString(),
          coach:{
            headline:daysUntilExam()==null?'Plano de hoje atualizado':'Plano de hoje · '+daysUntilExam()+' dias para o TEF',
            summaryPt:plan.summaryPt||action.summary,
            tasks:(first.tasks||[]).slice(0,3),
            actionPage:plan.priority==='listening'?'listening':plan.priority==='speaking'?'speaking':action.page
          }
        };
        persist();
      }
      render();
    }catch(e){
      if(force) toast(friendlyError(e),'error');
      render();
    }finally{
      if(btn) setBusy(btn,false);
    }
  }

  function handleDiagnosticClick(e){
    if(state.diagnostic?.completed){
      e.preventDefault(); e.stopImmediatePropagation();
      toast('O diagnóstico já está concluído. Vamos continuar o treino.');
      navigate(currentAction().page);
      return;
    }
    if(state.diagnostic?.active && (state.diagnostic?.total>0 || state.diagnostic?.listeningDone)){
      e.preventDefault(); e.stopImmediatePropagation();
      diagnosticRuntime={index:state.diagnostic.total||0,correct:state.diagnostic.correct||0};
      $('#diagnosticWorkspace')?.classList.remove('hidden');
      runNextDiagnosticListening();
    }
  }

  function wire(){
    recoverCompletedDiagnostic();

    if(typeof navigate==='function'){
      const baseNavigate=navigate;
      navigate=function(page){
        if(safePages.has(page)||page==='dashboard') state.lastPage=page;
        persist();
        const out=baseNavigate(page);
        render();
        return out;
      };
    }

    $('#startDiagnostic')?.addEventListener('click',handleDiagnosticClick,true);

    $('#saveExamDate')?.addEventListener('click',()=>{
      state.settings=state.settings||{};
      state.settings.examDate=$('#examDateInput')?.value||'';
      state.dailyCoach=null;
      persist(); render(); refreshAI(true);
      toast('Data do exame guardada.');
    });

    render();

    const last=state.lastPage;
    if(last && safePages.has(last) && last!=='diagnostic' && state.diagnostic?.completed){
      setTimeout(()=>navigate(last),0);
    }else if(last==='diagnostic' && state.diagnostic?.active && !state.diagnostic?.completed){
      setTimeout(()=>navigate('diagnostic'),0);
    }

    setTimeout(()=>refreshAI(false),1200);
  }

  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',wire);
  else wire();
})();