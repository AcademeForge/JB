/* ═══════════════════════════════════════════════════
   PULL TO REFRESH — smart merge
═══════════════════════════════════════════════════ */
(function(){
  const shell=document.getElementById('shell')||document.body;
  let pulling=false,pullStartY=0;
  function getScrollTop(){
    if($('profileScreen').style.display==='flex') return $('profilePageScroll').scrollTop;
    if($('myProfileScreen').style.display==='flex') return $('myProfilePageScroll').scrollTop;
    if(_activeTab==='feed') return $('feed').scrollTop;
    if(_activeTab==='chats') return $('chatsTab').scrollTop;
    return 0;
  }
  shell.addEventListener('touchstart',e=>{
    if(getScrollTop()>0) return;
    pullStartY=e.touches[0].clientY;pulling=true;
  },{passive:true});
  shell.addEventListener('touchend',async e=>{
    if(!pulling) return;
    const distance=e.changedTouches[0].clientY-pullStartY;
    if(distance>90){
      $('pullIndicator').style.display='block';
      await nxRefreshGlobal();
      $('pullIndicator').style.display='none';
    }
    pulling=false;
  });
})();

/* ═══════════════════════════════════════════════════
   DM POLLING FALLBACK (backs up Supabase realtime)
═══════════════════════════════════════════════════ */
let _dmPollTimer=null;
function nxStartDMPoll(peerKey){
  nxStopDMPoll();
  _dmPollTimer=setInterval(async()=>{
    if($('dmScreen').style.display!=='flex'||!_dmPeer||_dmPeer.key!==peerKey){
      nxStopDMPoll(); return;
    }
    await nxRefreshPeerChat(peerKey);
  }, 4000);
}
function nxStopDMPoll(){
  clearInterval(_dmPollTimer);
  _dmPollTimer=null;
}

/* ═══════════════════════════════════════════════════
   CHAT LIST BACKGROUND POLL
   When the user is on the chats tab (not inside a DM),
   refresh the chat list every 6 seconds so new messages
   appear without any manual pull-to-refresh.
═══════════════════════════════════════════════════ */
let _chatListPollTimer=null;
function nxStartChatListPoll(){
  nxStopChatListPoll();
  _chatListPollTimer=setInterval(async()=>{
    // Only poll when chats tab is visible and no DM thread is open
    if(_activeTab!=='chats') return;
    if($('dmScreen')&&$('dmScreen').style.display==='flex') return;
    await nxLoadChatsFromConnections();
  }, 6000);
}
function nxStopChatListPoll(){
  clearInterval(_chatListPollTimer);
  _chatListPollTimer=null;
}

/* ═══════════════════════════════════════════════════
   STORY VIEWER: DESKTOP DOUBLE-CLICK PAUSE/RESUME
═══════════════════════════════════════════════════ */
(function(){
  const sv=document.getElementById('storyViewer');
  if(!sv) return;
  sv.addEventListener('dblclick',e=>{
    if(e.target.tagName==='BUTTON'||e.target.tagName==='INPUT') return;
    if(_svPaused){
      _svPaused=false;
      const grp=_storyGroups[_svGroupIdx];
      const story=grp&&grp.stories[_svStoryIdx];
      if(story){
        if(story.media_type==='video'){
          const v=$('svMedia').querySelector('video');
          if(v){ v.play().catch(()=>{}); nxRunStoryProgress((v.duration||8)*1000); }
          else nxRunStoryProgress(STORY_VIDEO_FALLBACK_DURATION);
        } else {
          nxRunStoryProgress(STORY_IMG_DURATION);
        }
      }
    } else {
      _svPaused=true;
      clearTimeout(_svTimer); clearInterval(_svProgressInterval);
      const v=$('svMedia').querySelector('video'); if(v) v.pause();
    }
  });
})();

/* ═══════════════════════════════════════════════════
   SWIPE NAV — horizontal swipe on the main view switches tabs
   Left swipe  → Chats tab
   Right swipe → Feed tab
═══════════════════════════════════════════════════ */
(function(){
  const mv=document.getElementById('mainView');
  if(!mv) return;
  let _sx=0,_sy=0;
  mv.addEventListener('touchstart',e=>{
    _sx=e.touches[0].clientX;
    _sy=e.touches[0].clientY;
  },{passive:true});
  mv.addEventListener('touchend',e=>{
    const dx=e.changedTouches[0].clientX-_sx;
    const dy=Math.abs(e.changedTouches[0].clientY-_sy);
    // Must be mostly horizontal and at least 60px
    if(Math.abs(dx)<60||dy>Math.abs(dx)*0.8) return;
    // Don't trigger if a full-screen overlay is open
    const overlays=['dmScreen','profileScreen','searchScreen','myProfileScreen',
                    'storyViewer','commentsModal','composerModal','editProfileModal',
                    'menuModal','reportModal','followListModal','blockListModal',
                    'mainMenuModal','clearChatModal','dmOptionsModal','replyModal'];
    for(const id of overlays){
      const el=document.getElementById(id);
      if(el&&el.style.display==='flex'){return;}
      if(el&&el.classList.contains('open')){return;}
    }
    if(dx<0) nxSwitchTab('chats'); // swipe left → Chats
    else     nxSwitchTab('feed');  // swipe right → Feed
  },{passive:true});
})();

/* ═══════════════════════════════════════════════════
   EXPOSE GLOBALS
═══════════════════════════════════════════════════ */
window.nxOpenProfile=nxOpenProfile;
window.nxCloseProfile=nxCloseProfile;
window.nxOpenComments=nxOpenComments;
window.nxCloseComments=nxCloseComments;
window.nxLikePost=nxLikePost;
window.nxLikeComment=nxLikeComment;
window.nxOpenDM=nxOpenDM;
window.nxCloseDM=nxCloseDM;
window.nxMessageFromProfile=nxMessageFromProfile;
window.nxOpenEditProfile=nxOpenEditProfile;
window.nxCloseEditProfile=nxCloseEditProfile;
window.nxSwitchTab=nxSwitchTab;
window.nxSetMode=nxSetMode;
window.nxOpenComposer=nxOpenComposer;
window.nxCloseComposer=nxCloseComposer;
window.nxAttachPostImage=nxAttachPostImage;
window.nxHandlePostImage=nxHandlePostImage;
window.nxRemovePostImage=nxRemovePostImage;
window.nxAttachDMImage=nxAttachDMImage;
window.nxCreatePost=nxCreatePost;
window.nxCreateComment=nxCreateComment;
window.nxCreateReply=nxCreateReply;
window.nxOpenReply=nxOpenReply;
window.nxCloseReply=nxCloseReply;
window.nxOpenMenu=nxOpenMenu;
window.nxCloseMenu=nxCloseMenu;
window.nxTogglePin=nxTogglePin;
window.nxDeleteTarget=nxDeleteTarget;
window.nxEditTarget=nxEditTarget;
window.nxOpenReport=nxOpenReport;
window.nxCloseReport=nxCloseReport;
window.nxSelectReport=nxSelectReport;
window.nxSubmitReport=nxSubmitReport;
window.nxToggleFollow=nxToggleFollow;
window.nxOpenFollowers=nxOpenFollowers;
window.nxOpenFollowing=nxOpenFollowing;
window.nxOpenFollowersFor=nxOpenFollowersFor;
window.nxOpenFollowingFor=nxOpenFollowingFor;
window.nxCloseFollowList=nxCloseFollowList;
window.nxUnfollowFromList=nxUnfollowFromList;
window.nxRemoveFollowerFromList=nxRemoveFollowerFromList;
window.nxBlockFromFollowerList=nxBlockFromFollowerList;
window.nxOpenSearchScreen=nxOpenSearchScreen;
window.nxCloseSearchScreen=nxCloseSearchScreen;
window.nxClearFullSearch=nxClearFullSearch;
window.nxFullSearchTyping=nxFullSearchTyping;
window.nxSendDM=nxSendDM;
window.nxDMTyping=nxDMTyping;
window.nxHandleDMImage=nxHandleDMImage;
window.nxRemoveDMImage=nxRemoveDMImage;
window.nxCancelEditDM=nxCancelEditDM;
window.nxStartDMReply=nxStartDMReply;
window.nxCancelDMReply=nxCancelDMReply;
window.nxReplyFromBubbleBtn=nxReplyFromBubbleBtn;
window.nxLoadOlderDMs=nxLoadOlderDMs;
window.nxShowBubbleContextMenu=nxShowBubbleContextMenu;
window.nxSaveProfile=nxSaveProfile;
window.nxDisplayNameTyping=nxDisplayNameTyping;
window.nxUsernameTyping=nxUsernameTyping;
window.nxCommentTyping=nxCommentTyping;
window.nxPostTyping=nxPostTyping;
window.nxReplyTyping=nxReplyTyping;
window.nxToggleReplies=nxToggleReplies;
window.nxHandleAvatarUpload=nxHandleAvatarUpload;
window.nxRemoveAvatar=nxRemoveAvatar;
window.nxOpenProfileFromDM=nxOpenProfileFromDM;
window.nxOpenDMOptions=nxOpenDMOptions;
window.nxCloseDMOptions=nxCloseDMOptions;
window.nxOpenClearChatConfirm=nxOpenClearChatConfirm;
window.nxCloseClearChatConfirm=nxCloseClearChatConfirm;
window.nxConfirmClearChat=nxConfirmClearChat;
window.nxOpenMainMenu=nxOpenMainMenu;
window.nxCloseMainMenu=nxCloseMainMenu;
window.nxOpenBlockedUsers=nxOpenBlockedUsers;
window.nxCloseBlockedUsers=nxCloseBlockedUsers;
window.nxBlockCurrentPeer=nxBlockCurrentPeer;
window.nxUnblockCurrentPeer=nxUnblockCurrentPeer;
window.nxUnblockFromList=nxUnblockFromList;
window.nxOpenNotifications=nxOpenNotifications;
window.nxCloseNotifications=nxCloseNotifications;
window.nxNotificationFollowBack=nxNotificationFollowBack;
window.nxSetThemeMode=nxSetThemeMode;
window.goToLogin=goToLogin;

/* ═══════════════════════════════════════════════════
   IMAGE LIGHTBOX — pinch/wheel zoom + drag pan
═══════════════════════════════════════════════════ */
(function(){
  const MIN_SCALE = 1;
  const MAX_SCALE = 6;
  const ZOOM_STEP = 0.25;

  let _scale = 1;
  let _tx = 0, _ty = 0;        // translation offsets
  let _dragging = false;
  let _dragStartX = 0, _dragStartY = 0;
  let _dragOriginTx = 0, _dragOriginTy = 0;

  // Pinch state
  let _pinchActive = false;
  let _pinchStartDist = 0;
  let _pinchStartScale = 1;
  let _pinchMidX = 0, _pinchMidY = 0;

  function _lbEl(){ return document.getElementById('imgLightbox'); }
  function _wrap(){ return document.getElementById('lbImgWrap'); }
  function _img(){ return document.getElementById('lbImg'); }
  function _pct(){ return document.getElementById('lbZoomPct'); }

  function _applyTransform(){
    const wrap = _wrap();
    if(!wrap) return;
    // Clamp translation so image edges don't go too far out of view
    const img = _img();
    const iw = img.offsetWidth * _scale;
    const ih = img.offsetHeight * _scale;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const maxTx = _scale > 1 ? Math.max(0,(iw - vw)/2) : 0;
    const maxTy = _scale > 1 ? Math.max(0,(ih - vh)/2) : 0;
    _tx = Math.max(-maxTx, Math.min(maxTx, _tx));
    _ty = Math.max(-maxTy, Math.min(maxTy, _ty));
    // Use a combined matrix so the lightbox CSS open-scale animation doesn't fight us
    wrap.style.transform = `translate(${_tx}px,${_ty}px) scale(${_scale})`;
    wrap.style.transition = _dragging || _pinchActive ? 'none' : 'transform .18s ease';
    const p = _pct();
    if(p) p.textContent = Math.round(_scale * 100) + '%';
  }

  function _resetTransform(){
    _scale = 1; _tx = 0; _ty = 0;
    _applyTransform();
  }

  window.nxOpenLightbox = function(src){
    const lb = _lbEl();
    const img = _img();
    if(!lb || !img) return;
    _resetTransform();
    img.src = src;
    lb.classList.add('open');
    document.addEventListener('keydown', _onKey);
  };

  window.nxCloseLightbox = function(){
    const lb = _lbEl();
    if(!lb) return;
    lb.classList.remove('open');
    document.removeEventListener('keydown', _onKey);
    // Reset after transition
    setTimeout(()=>{
      const img = _img();
      if(img) img.src='';
      _resetTransform();
    }, 260);
  };

  window.nxLbZoom = function(delta){
    _scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, _scale + delta));
    if(_scale === MIN_SCALE){ _tx = 0; _ty = 0; }
    _applyTransform();
  };

  function _onKey(e){
    if(e.key === 'Escape'){ nxCloseLightbox(); return; }
    if(e.key === '+' || e.key === '='){ nxLbZoom(ZOOM_STEP); return; }
    if(e.key === '-'){ nxLbZoom(-ZOOM_STEP); return; }
    if(e.key === '0'){ _resetTransform(); return; }
  }

  // Click backdrop to close (not on image or zoom bar)
  document.addEventListener('DOMContentLoaded', ()=>{
    const lb = _lbEl();
    if(!lb) return;

    // Close on backdrop click
    lb.addEventListener('click', e=>{
      if(e.target === lb) nxCloseLightbox();
    });

    // ── MOUSE WHEEL ZOOM ──
    lb.addEventListener('wheel', e=>{
      if(!lb.classList.contains('open')) return;
      e.preventDefault();
      const delta = e.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP;
      _scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, _scale + delta));
      if(_scale === MIN_SCALE){ _tx = 0; _ty = 0; }
      _applyTransform();
    }, { passive: false });

    // ── MOUSE DRAG PAN ──
    const wrap = _wrap();
    if(wrap){
      wrap.addEventListener('mousedown', e=>{
        if(_scale <= 1) return;
        e.preventDefault();
        _dragging = true;
        _dragStartX = e.clientX;
        _dragStartY = e.clientY;
        _dragOriginTx = _tx;
        _dragOriginTy = _ty;
      });
      document.addEventListener('mousemove', e=>{
        if(!_dragging) return;
        _tx = _dragOriginTx + (e.clientX - _dragStartX);
        _ty = _dragOriginTy + (e.clientY - _dragStartY);
        _applyTransform();
      });
      document.addEventListener('mouseup', ()=>{ _dragging = false; });

      // Double-click: toggle between 1x and 2.5x
      wrap.addEventListener('dblclick', e=>{
        e.stopPropagation();
        if(_scale > 1){
          _resetTransform();
        } else {
          _scale = 2.5;
          _applyTransform();
        }
      });
    }

    // ── TOUCH: DRAG + PINCH ──
    lb.addEventListener('touchstart', e=>{
      if(!lb.classList.contains('open')) return;
      if(e.touches.length === 2){
        _pinchActive = true;
        _dragging = false;
        const t0 = e.touches[0], t1 = e.touches[1];
        _pinchStartDist = Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY);
        _pinchStartScale = _scale;
        _pinchMidX = (t0.clientX + t1.clientX) / 2;
        _pinchMidY = (t0.clientY + t1.clientY) / 2;
      } else if(e.touches.length === 1 && _scale > 1){
        _dragging = true;
        _dragStartX = e.touches[0].clientX;
        _dragStartY = e.touches[0].clientY;
        _dragOriginTx = _tx;
        _dragOriginTy = _ty;
      }
    }, { passive: true });

    lb.addEventListener('touchmove', e=>{
      if(!lb.classList.contains('open')) return;
      if(_pinchActive && e.touches.length === 2){
        e.preventDefault();
        const t0 = e.touches[0], t1 = e.touches[1];
        const dist = Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY);
        _scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, _pinchStartScale * (dist / _pinchStartDist)));
        if(_scale === MIN_SCALE){ _tx = 0; _ty = 0; }
        _applyTransform();
      } else if(_dragging && e.touches.length === 1){
        e.preventDefault();
        _tx = _dragOriginTx + (e.touches[0].clientX - _dragStartX);
        _ty = _dragOriginTy + (e.touches[0].clientY - _dragStartY);
        _applyTransform();
      }
    }, { passive: false });

    lb.addEventListener('touchend', e=>{
      if(e.touches.length < 2) _pinchActive = false;
      if(e.touches.length === 0) _dragging = false;
      // Snap back to MIN_SCALE if user pinched below it
      if(_scale < MIN_SCALE + 0.05){
        _scale = MIN_SCALE; _tx = 0; _ty = 0;
        _applyTransform();
      }
    }, { passive: true });
  });
})();

document.addEventListener('DOMContentLoaded',init);
