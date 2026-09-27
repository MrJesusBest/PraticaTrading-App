(function(g){
  function num(v,fallback=0){ const n=Number(v); return Number.isFinite(n)?n:fallback; }
  function clamp(v,min=0,max=100){ return Math.max(min,Math.min(max,num(v))); }
  function normalize(training, ids){
    const t=(training&&typeof training==='object')?training:{};
    t.mode=['learn','guided','exam'].includes(t.mode)?t.mode:'learn';
    t.skills=(t.skills&&typeof t.skills==='object')?t.skills:{};
    t.completed={A:num(t.completed?.A),B:num(t.completed?.B)};
    t.guided={A:num(t.guided?.A),B:num(t.guided?.B)};
    t.total=num(t.total);
    for(const section of ['A','B']){
      for(const id of ids[section]||[]){
        const p=(t.skills[id]&&typeof t.skills[id]==='object')?t.skills[id]:{};
        t.skills[id]={
          mastery:clamp(p.mastery),
          tries:num(p.tries),
          passes:num(p.passes),
          lastScore:Number.isFinite(Number(p.lastScore))?Number(p.lastScore):null,
          next:p.next||null
        };
      }
    }
    return t;
  }
  function average(training, ids, section){
    const list=ids[section]||[];
    if(!list.length)return 0;
    return Math.round(list.reduce((sum,id)=>sum+clamp(training.skills?.[id]?.mastery),0)/list.length);
  }
  function nextStage(training, ids){
    const a=average(training,ids,'A'), b=average(training,ids,'B');
    if(a<100)return {section:'A',mode:'learn',code:'A_BASE',label:'Concluir Base Section A'};
    if(num(training.guided?.A)<2)return {section:'A',mode:'guided',code:'A_GUIDED',label:'Treino Guiado Section A'};
    if(b<100)return {section:'B',mode:'learn',code:'B_BASE',label:'Concluir Base Section B'};
    if(num(training.guided?.B)<2)return {section:'B',mode:'guided',code:'B_GUIDED',label:'Treino Guiado Section B'};
    return {section:'A',mode:'exam',code:'EXAM',label:'Simulação TEF'};
  }
  function examReady(training,ids){
    return average(training,ids,'A')===100 && average(training,ids,'B')===100 &&
      num(training.guided?.A)>=2 && num(training.guided?.B)>=2;
  }
  g.Target6SpeakingFlow={normalize,average,nextStage,examReady};
})(globalThis);