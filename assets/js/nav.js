(function(){
  'use strict';

  const navIds = ['feed', 'search', 'post', 'chats', 'profile'];

  function setNavActive(target){
    navIds.forEach(id=>{
      const btn = document.getElementById('nav-' + id);
      if(btn) btn.classList.toggle('active', id === target);
    });
  }

  function closeOverlay(id, closeFn){
    const el = document.getElementById(id);
    if(el && el.style.display === 'flex' && typeof closeFn === 'function') closeFn();
  }

  function nxNavTo(target){
    if(!target) return;
    if(window.afAuth && !window.afAuth.afIsLoggedIn()){
      window.afAuth.enterGate();
      return;
    }

    if(target === 'feed' || target === 'chats'){
      closeOverlay('searchScreen', window.nxCloseSearchScreen);
      if(document.getElementById('profileScreen')?.style.display === 'flex') window.nxCloseProfile?.();
      if(document.getElementById('myProfileScreen')?.style.display === 'flex') window.nxCloseMyProfile?.();
      window.nxSwitchTab?.(target);
      setNavActive(target);
      return;
    }

    if(target === 'search'){
      if(document.getElementById('myProfileScreen')?.style.display === 'flex') window.nxCloseMyProfile?.();
      if(document.getElementById('profileScreen')?.style.display === 'flex') window.nxCloseProfile?.();
      window.nxOpenSearchScreen?.();
      setNavActive('search');
      return;
    }

    if(target === 'post'){
      window.nxOpenComposer?.();
      setNavActive('post');
      return;
    }

    if(target === 'profile'){
      closeOverlay('searchScreen', window.nxCloseSearchScreen);
      if(document.getElementById('profileScreen')?.style.display === 'flex') window.nxCloseProfile?.();
      window.nxOpenMyProfile?.();
      setNavActive('profile');
    }
  }

  document.addEventListener('DOMContentLoaded', ()=>{
    setNavActive('feed');
    document.getElementById('pillRelevant')?.addEventListener('click', e=>{
      e.preventDefault();
      window.nxSetMode?.('relevant');
    });
    document.getElementById('pillRecent')?.addEventListener('click', e=>{
      e.preventDefault();
      window.nxSetMode?.('recent');
    });
    document.getElementById('tabFeed')?.addEventListener('click', e=>{
      e.preventDefault();
      window.nxSwitchTab?.('feed');
    });
    document.getElementById('tabChats')?.addEventListener('click', e=>{
      e.preventDefault();
      window.nxSwitchTab?.('chats');
    });
    const modalIds = ['composerModal', 'searchScreen', 'myProfileScreen'];
    modalIds.forEach(id=>{
      const el = document.getElementById(id);
      if(!el) return;
      const observer = new MutationObserver(()=>{
        const open = el.style.display === 'flex';
        if(!open && (id === 'composerModal' || id === 'searchScreen' || id === 'myProfileScreen')){
          const active = document.getElementById('chatsTab')?.classList.contains('hidden') ? 'feed' : 'chats';
          setNavActive(active);
        }
      });
      observer.observe(el, {attributes:true, attributeFilter:['style', 'class']});
    });
  });

  window.nxNavTo = nxNavTo;
  window.nxSetNavActive = setNavActive;
})();
