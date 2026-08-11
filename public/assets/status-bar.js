(function(){
  'use strict';

  const CSS = `
    #extrajud-running-bar{
      position:fixed;top:0;left:0;right:0;height:4px;z-index:99998;
      background:transparent;pointer-events:none;
      transition:opacity .3s;opacity:0;overflow:hidden;
    }
    #extrajud-running-bar.active{
      opacity:1;pointer-events:auto;cursor:default;
      background:#16a34a;
    }
    #extrajud-running-bar::after{
      content:'';position:absolute;top:0;left:-40%;width:40%;height:100%;
      background:linear-gradient(90deg,transparent,rgba(255,255,255,.9),transparent);
      animation:extrajud-bar-scan 1.2s ease-in-out infinite;
    }
    @keyframes extrajud-bar-scan{
      0%{left:-40%}
      100%{left:100%}
    }
    #extrajud-running-bar .bar-tooltip{
      position:absolute;top:8px;left:50%;transform:translateX(-50%);
      background:#16a34a;color:#fff;padding:5px 14px;border-radius:8px;
      font-size:0.75rem;font-family:'Inter',sans-serif;font-weight:600;
      white-space:nowrap;opacity:0;transition:opacity .2s;pointer-events:none;
      box-shadow:0 4px 12px rgba(22,163,74,.4);
      display:flex;align-items:center;gap:8px;
    }
    #extrajud-running-bar .bar-tooltip::before{
      content:'';position:absolute;top:-5px;left:50%;transform:translateX(-50%);
      border-left:6px solid transparent;border-right:6px solid transparent;
      border-bottom:6px solid #16a34a;
    }
    #extrajud-running-bar.active:hover .bar-tooltip{opacity:1}
    #extrajud-running-bar .bar-pulse{
      width:8px;height:8px;border-radius:50%;background:#fff;
      animation:extrajud-pulse 1s ease-in-out infinite;
      flex-shrink:0;
    }
    @keyframes extrajud-pulse{
      0%,100%{opacity:1;transform:scale(1)}
      50%{opacity:.3;transform:scale(.6)}
    }
  `;

  function injectStyles(){
    if(document.getElementById('extrajud-running-bar-styles')) return;
    const s=document.createElement('style');
    s.id='extrajud-running-bar-styles';
    s.textContent=CSS;
    document.head.appendChild(s);
  }

  function createBar(){
    if(document.getElementById('extrajud-running-bar')) return document.getElementById('extrajud-running-bar');
    const bar=document.createElement('div');
    bar.id='extrajud-running-bar';
    bar.innerHTML=`<div class="bar-tooltip"><span class="bar-pulse"></span><span class="bar-label">Executando...</span></div>`;
    document.body.appendChild(bar);
    return bar;
  }

  const TYPE_LABELS={
    projudi:'PROJUDI - Citações/Intimações',
    arquivados:'PROJUDI - Arquivados',
    pje:'PJE - 1º/2º Grau',
    sharepoint:'SharePoint - Criar Pastas',
    protocolo:'Protocolos Postais',
    unknown:'Automação em execução'
  };

  let currentType='unknown';

  function init(){
    injectStyles();
    const bar=createBar();

    if(!window.api) return;

    window.api.on('automation-status',(status)=>{
      if(status===true||status==='running'){
        bar.classList.add('active');
        const label=bar.querySelector('.bar-label');
        if(label) label.textContent=TYPE_LABELS[currentType]||TYPE_LABELS.unknown;
      }else{
        bar.classList.remove('active');
      }
    });

    window.api.on('script-finished',()=>{
      bar.classList.remove('active');
      currentType='unknown';
    });

    // Expose setter for pages to report automation type
    window.setAutomationType=function(type){
      currentType=type||'unknown';
      const label=bar.querySelector('.bar-label');
      if(label&&bar.classList.contains('active')){
        label.textContent=TYPE_LABELS[currentType]||TYPE_LABELS.unknown;
      }
    };
  }

  if(document.readyState==='loading'){
    document.addEventListener('DOMContentLoaded',init);
  }else{
    init();
  }
})();
