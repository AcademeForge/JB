/* ═══════════════════════════════════════════════════
   SEARCH
═══════════════════════════════════════════════════ */
let _searchTimer=null;
function nxOpenSearchScreen(){
  nxBringToFront('searchScreen');
  $('searchScreen').style.display='flex';
  setTimeout(()=>$('fullSearchInp')&&$('fullSearchInp').focus(),10);
}
function nxCloseSearchScreen(){
  $('searchScreen').style.display='none';
  nxClearFullSearch();
  nxForceRepaint();
}
function nxClearFullSearch(){
  if($('fullSearchInp')) $('fullSearchInp').value='';
  if($('fullSearchClear')) $('fullSearchClear').style.display='none';
  $('fullSearchResults').innerHTML='<div class="state-msg"><span>🔍</span><span>Search for students by name or username.</span></div>';
}
function nxFullSearchTyping(){
  const v=($('fullSearchInp').value||'').trim();
  const clearBtn=$('fullSearchClear');
  if(clearBtn) clearBtn.style.display=v?'block':'none';
  clearTimeout(_searchTimer);
  if(!v){nxClearFullSearch();return;}
  _searchTimer=setTimeout(()=>nxDoSearch(v),300);
}
async function nxDoSearch(q){
  const box=$('fullSearchResults'); if(!box) return;
  box.innerHTML='<div class="state-msg">Loading…</div>';
  const res=await edgeCall({action:'search_users',query:q});
  let users=res&&res.ok&&Array.isArray(res.users)?res.users:[];
  users=users.filter(u=>u.student_key!==sKey());
  if(!users.length){box.innerHTML=`<div class="state-msg"><span>No users found for "${esc(q)}".</span></div>`;return;}
  box.innerHTML=users.map(u=>{
    const isVer=!!u.is_verified;
    const nameHtml = isVer
      ? `<span class="gold-name">${esc(u.student_name)}</span>${verBadgeHTML(true)}`
      : esc(u.student_name);
    return `
    <div style="display:flex;align-items:center;gap:12px;padding:14px;cursor:pointer;border-bottom:1px solid var(--b1);background:var(--card-s);border-radius:12px;margin-bottom:8px;box-shadow:var(--sh)${isVer?';border:1px solid rgba(245,158,11,.3)':''}" onclick="nxCloseSearchScreen();nxOpenProfile('${esc(u.student_key)}','${esc(u.student_name).replace(/'/g,"&#39;")}')">
      ${avatarHTML(u.student_name,u.emoji||'',u.avatar_url||'',' avatar-sm','',isVer)}
      <div style="flex:1;min-width:0;">
       <div style="font-family:var(--fd);font-size:14px;font-weight:800;color:var(--t1);display:flex;align-items:center;gap:0;">
          ${nameHtml}
       </div>
       ${u.username?`<div style="font-size:12px;color:var(--tm);font-weight:600;margin-top:2px;">@${esc(u.username)}</div>`:'<div style="font-size:12px;color:var(--tm);margin-top:2px;">No username set</div>'}
      </div>
      <span style="font-size:12px;font-weight:700;color:var(--p);background:var(--p-soft);padding:6px 12px;border-radius:99px;">Profile</span>
    </div>`;
  }).join('');
}

/* ═══════════════════════════════════════════════════
   AVATAR UPLOAD (photo only — no emoji avatar)
═══════════════════════════════════════════════════ */
function nxHandleAvatarUpload(input){
  const file=input.files&&input.files[0];
  if(!file) return;
  if(file.size>2*1024*1024){showToast('Please reduce the image size to less than 2 MB and try again.','err');return;}
  const reader=new FileReader();
  reader.onload=e=>{
    _pendingAvatarDataUrl=e.target.result;
    nxRenderEditAvatarPreview();
    $('removeAvatarBtn').style.display='block';
  };
  reader.readAsDataURL(file);
}
function nxRemoveAvatar(){
  _pendingAvatarDataUrl=null;
  localStorage.removeItem('af_avatar_url');
  $('removeAvatarBtn').style.display='none';
  nxRenderEditAvatarPreview();
}
function nxRenderEditAvatarPreview(){
  const el=$('editProfileAvatarPreview');
  if(!el) return;
  const avatarUrl=_pendingAvatarDataUrl||getMyAvatarUrl();
  const name=sName();
  if(avatarUrl){
    el.className='avatar avatar-lg';
    el.innerHTML=`<img src="${esc(avatarUrl)}" style="width:64px;height:64px;object-fit:cover;border-radius:16px;" onerror="this.parentElement.innerHTML='${esc(initials(name))}'"/>`;
  } else {
    el.className='avatar avatar-lg initials';
    el.textContent=initials(name);
  }
}

/* ═══════════════════════════════════════════════════
   FORCE REPAINT
═══════════════════════════════════════════════════ */
function nxForceRepaint(){
  const shell=$('shell');
  if(!shell) return;
  requestAnimationFrame(()=>{
    shell.style.transform='translateZ(0)';
    requestAnimationFrame(()=>{ shell.style.transform=''; });
  });
}

function nxOpenEditProfile(){
  _pendingAvatarDataUrl=null;
  nxRenderEditAvatarPreview();
  $('displayNameInput').value=sName();
  $('displayNameHint').textContent='2-40 characters. This is shown on your posts, comments and messages.';
  $('displayNameHint').style.color='var(--tm)';
  $('usernameInput').value=getMyUsername();
  $('bioInput').value=localStorage.getItem('af_bio')||'';
  $('usernameHint').textContent='3-24 chars: lowercase letters, numbers, underscore.';
  $('usernameHint').style.color='var(--tm)';
  const existingUrl=getMyAvatarUrl();
  $('removeAvatarBtn').style.display=existingUrl?'block':'none';
  nxBringToFront('editProfileModal');
  $('editProfileModal').style.display='flex';
}
function nxCloseEditProfile(){
  $('editProfileModal').style.display='none';
  nxForceRepaint();
}
function nxDisplayNameTyping(){
  const hint=$('displayNameHint');
  const v=($('displayNameInput').value||'').trim();
  if(!v){hint.textContent='Display name cannot be empty.';hint.style.color='var(--err)';return;}
  if(v.length<2){hint.textContent='Too short.';hint.style.color='var(--err)';return;}
  if(v.length>40){hint.textContent='Too long.';hint.style.color='var(--err)';return;}
  hint.textContent='2-40 characters. This is shown on your posts, comments and messages.';
  hint.style.color='var(--tm)';
}

let _usernameCheckTimer=null;
function nxUsernameTyping(){
  const v=($('usernameInput').value||'').toLowerCase().replace(/[^a-z0-9_]/g,'');
  $('usernameInput').value=v;
  clearTimeout(_usernameCheckTimer);
  const hint=$('usernameHint');
  if(!v){hint.textContent='3-24 chars: lowercase letters, numbers, underscore.';hint.style.color='var(--tm)';return;}
  if(v.length<3){hint.textContent='Too short.';hint.style.color='var(--err)';return;}
  _usernameCheckTimer=setTimeout(async()=>{
    const res=await edgeCall({action:'check_username',username:v});
    if(res&&res.ok){
      hint.textContent=res.available?'Available ✓':'Already taken.';
      hint.style.color=res.available?'var(--ok)':'var(--err)';
    }
  },350);
}

async function nxSaveProfile(){
  const displayName=($('displayNameInput').value||'').trim();
  const username=($('usernameInput').value||'').toLowerCase().trim();
  const bio=($('bioInput').value||'').trim();
  if(!displayName||displayName.length<2||displayName.length>40){showToast('Display name must be 2-40 characters.','err');return;}
  if(username&&!/^[a-z0-9_]{3,24}$/.test(username)){showToast('Username must be 3-24 chars.','err');return;}
  $('saveProfileBtn').disabled=true;
  let finalAvatarUrl = getMyAvatarUrl();
  if(_pendingAvatarDataUrl){
    const uploadRes = await edgeCall({action:'upload_avatar',avatar_data_url:_pendingAvatarDataUrl});
    if(uploadRes&&uploadRes.ok&&uploadRes.avatar_url){
      finalAvatarUrl=uploadRes.avatar_url;
    } else {
      finalAvatarUrl=_pendingAvatarDataUrl;
    }
  } else if(!_pendingAvatarDataUrl && !getMyAvatarUrl() && $('removeAvatarBtn').style.display==='none'){
    finalAvatarUrl='';
  }
  const res=await edgeCall({
    action:'save_username',
    name:displayName,
    username:username||getMyUsername()||('student'+Math.floor(Math.random()*99999)),
    bio,
    avatar_url:finalAvatarUrl
  });
  $('saveProfileBtn').disabled=false;
  if(!res||!res.ok){showToast(res?.message||'Could not save profile.','err');return;}
  const nameChanged = displayName !== sName();
  if(finalAvatarUrl) localStorage.setItem('af_avatar_url',finalAvatarUrl);
  else localStorage.removeItem('af_avatar_url');
  localStorage.setItem('af_student_name', displayName);
  if(res.profile&&res.profile.username) localStorage.setItem('af_username',res.profile.username);
  else if(username) localStorage.setItem('af_username',username);
  localStorage.setItem('af_bio',bio);
  _pendingAvatarDataUrl=null;
  syncAvatarBtn();
  nxCloseEditProfile();
  $('usernameBanner').classList.add('hidden');
  showToast(nameChanged?'Profile updated! Your new name is now live.':'Profile updated!');
  // Refresh everything that can display the name/avatar so the change
  // is reflected immediately across feed, profile and chats.
  _cache.profiles.delete(sKey());
  await Promise.all([
    nxLoadPosts(true),
    nxPreloadConnections()
  ]);
  if($('myProfileScreen').style.display==='flex') nxOpenMyProfile();
  if($('chatsTab') && !$('chatsTab').classList.contains('hidden')) nxRenderChatList();
}

/* ═══════════════════════════════════════════════════
   CHAT LIST RENDER (with gold verified styling)
═══════════════════════════════════════════════════ */
/* ═══════════════════════════════════════════════════
   PENDING FOLLOWS BADGE
   Badge on the Chats tab showing how many people follow
   you but you haven't followed back yet (= potential DMs).
═══════════════════════════════════════════════════ */
function nxUpdatePendingFollowsBadge(){
  const badge=$('pendingFollowsBadge');
  if(!badge) return;
  const count=_cache.myFollowers.filter(u=>{
    const key=String(u.student_key||u.key||'');
    return key && key!==sKey() && !_cache.followingKeys.has(key);
  }).length;
  if(count>0){
    badge.textContent=count+' pending';
    badge.style.display='inline-block';
  } else {
    badge.style.display='none';
  }
}
window.nxUpdatePendingFollowsBadge=nxUpdatePendingFollowsBadge;

/* ═══════════════════════════════════════════════════
   SUGGESTED USERS TO FOLLOW
   Shows followers who aren't followed back yet —
   tapping "Follow Back" makes the follow mutual so DMs unlock.
═══════════════════════════════════════════════════ */
function nxRenderSuggestedUsers(){
  nxUpdatePendingFollowsBadge(); // keep badge in sync with suggestion count
  const wrap=$('suggestedUsersWrap');
  const list=$('suggestedUsersList');
  const moreBtn=$('suggestedShowMoreBtn');
  const caughtUpMsg=$('suggestedAllCaughtUp');
  if(!wrap||!list) return;

  // People who follow me but I don't follow back yet — the full set;
  // pagination below only controls how many of these are *rendered*,
  // so "Show more" is instant (no extra network round-trip).
  const allSuggestions=_cache.myFollowers.filter(u=>{
    const key=String(u.student_key||u.key||'');
    return key && key!==sKey() && !_cache.followingKeys.has(key);
  });

  if(!allSuggestions.length){
    wrap.style.display='none';
    // Reset pagination so the next time suggestions appear they start at 5 again
    _suggestedVisibleCount=5;
    _suggestedNextIncrement=5;
    return;
  }
  wrap.style.display='block';

  const visible=allSuggestions.slice(0,_suggestedVisibleCount);
  list.innerHTML=visible.map(u=>{
    const key=String(u.student_key||u.key||'');
    const name=u.student_name||u.name||'Student';
    const emoji=u.emoji||'';
    const avatarUrl=u.avatar_url||'';
    const isVer=!!u.is_verified;
    const safeName=esc(name).replace(/'/g,"&#39;");
    const safeKey=esc(key);
    return `<div class="suggested-user-card" id="su-card-${safeKey}">
      <div onclick="nxOpenProfile('${safeKey}','${safeName}')" style="cursor:pointer;flex-shrink:0;" title="View profile">${avatarHTML(name,emoji,avatarUrl,'','',isVer)}</div>
      <div class="su-info" onclick="nxOpenProfile('${safeKey}','${safeName}')" style="cursor:pointer;" title="View profile">
        <div class="su-name">${isVer?`<span class="gold-name">${esc(name)}</span>${verBadgeHTML(true)}`:esc(name)}</div>
        <div class="su-sub"><span style="color:var(--accent);font-weight:700;">Follows you</span> · Follow back to chat</div>
      </div>
      <button class="su-btn" id="su-btn-${safeKey}" onclick="nxSuggestedFollow('${safeKey}','${safeName}',this)">Follow</button>
    </div>`;
  }).join('');

  const remaining=allSuggestions.length-visible.length;
  if(remaining>0){
    if(moreBtn){
      moreBtn.classList.remove('hidden');
      moreBtn.textContent=`Show ${Math.min(_suggestedNextIncrement,remaining)} more`;
    }
    if(caughtUpMsg) caughtUpMsg.classList.add('hidden');
  } else {
    if(moreBtn) moreBtn.classList.add('hidden');
    if(caughtUpMsg) caughtUpMsg.classList.remove('hidden');
  }
}

function nxShowMoreSuggestions(){
  _suggestedVisibleCount+=_suggestedNextIncrement;
  _suggestedNextIncrement*=2; // 5 → 10 → 20 → 40 …
  nxRenderSuggestedUsers();
}
window.nxShowMoreSuggestions=nxShowMoreSuggestions;

async function nxSuggestedFollow(key, name, btn){
  if(!key) return;
  btn.disabled=true; btn.textContent='…';
  const res=await edgeCall({action:'toggle_follow',target_key:key});
  if(res&&res.ok&&res.following){
    // Update local cache
    _cache.followingKeys.add(key);
    const profile=_cache.profiles.get(key)||{student_key:key,student_name:name};
    _cache.myFollowing.push(profile);
    btn.textContent='Following';
    btn.style.background='var(--tm)';
    btn.disabled=true;
    // Animate card out after 1.2s
    setTimeout(()=>{
      const card=$('su-card-'+key);
      if(card){ card.style.transition='opacity .3s,max-height .4s'; card.style.opacity='0'; card.style.maxHeight='0'; card.style.overflow='hidden';
        setTimeout(()=>{ card.remove(); nxRenderSuggestedUsers(); },400);
      }
    },1200);
    showToast('Following '+name+'! DMs are now unlocked.');
  } else {
    btn.disabled=false; btn.textContent='Follow';
    showToast(res?.message||'Could not follow.','err');
  }
}
window.nxSuggestedFollow=nxSuggestedFollow;

function nxRenderChatList(){
  nxRenderSuggestedUsers(); // refresh suggested users panel
  const box=$('chatList'); if(!box) return;
  if(!_cache.chatList.length){
    // Only show "no conversations" if we've already finished loading
    if(_chatsLoaded){
      box.innerHTML='<div class="state-msg"><span>💬</span><span>No conversations yet.<br>Use search to message someone.</span></div>';
    } else {
      // Shimmer skeleton rows while chats are still being fetched
      const skelRow=`<div class="chat-skel-row">
        <div class="af-skel chat-skel-avatar"></div>
        <div class="chat-skel-body">
          <div class="af-skel chat-skel-name"></div>
          <div class="af-skel chat-skel-preview"></div>
        </div>
      </div>`;
      box.innerHTML = skelRow.repeat(5);
    }
    return;
  }
  box.innerHTML=_cache.chatList.map(c=>{
    const hasUnread=getChatUnreadCount(c.messages)>0;
    const peer=c.peer;
    const isVer=!!peer.is_verified;
    const nameHtml = isVer
      ? `<span class="gold-name">${esc(peer.student_name)}</span>${verBadgeHTML(true)}`
      : esc(peer.student_name);
    const pres=formatPresence(_cache.presence[peer.student_key]);
    const presHtml=pres
      ? (pres.online
          ? `<span class="presence-online">Active now</span>`
          : `<span class="presence-offline">${esc(pres.label)}</span>`)
      : '';
    const isNewMsg = _newWhileFeed.has(peer.student_key);
    return `<div class="conv-item${hasUnread?' unread':''}${isVer?' gold-conv':''}${isNewMsg?' has-new-msg':''}" onclick="nxOpenDM('${esc(peer.student_key)}','${esc(peer.student_name).replace(/'/g,"&#39;")}')">
      ${avatarHTML(peer.student_name,peer.emoji||'',peer.avatar_url||'',' avatar-sm','',isVer)}
      <div class="conv-info">
       <div class="conv-name" style="display:flex;align-items:center;gap:0;">
          ${nameHtml}
          ${hasUnread?'<span class="unread-dot"></span>':''}
          ${isNewMsg?'<span class="conv-new-badge">new</span>':''}
       </div>
       <div class="conv-preview" style="${(hasUnread||isNewMsg)?'font-weight:700;color:var(--t1);':''}">${esc(c.latest.is_deleted?'Message deleted':(c.latest.image_url && !c.latest.text ? '📷 Image' : c.latest.text))}</div>
      </div>
      <div class="conv-meta">
        <div class="conv-time">${esc(timeAgo(c.latest.ts))}</div>
        ${presHtml}
      </div>
    </div>`;
  }).join('');
}

/* ═══════════════════════════════════════════════════
   DM SCREEN (gold identity for verified peers)
═══════════════════════════════════════════════════ */
async function nxOpenDM(peerKey,peerName){
  if(peerKey===sKey()) return;
  // Clear the "new message" row indicator for this conversation
  _newWhileFeed.delete(peerKey);
  _dmPeer={key:peerKey,name:peerName};
  _dmEditingId=null; hide('dmEditBanner');
  _dmReplyTo=null; hide('dmReplyBanner');
  _dmOldestTs=null; _dmLoadingOlder=false; _dmPeerReadAt=null;
  nxInitDMReactionEvents(); // attach double-tap/dblclick reaction listener (idempotent)
  $('dmPeerName').textContent=peerName;
  $('dmInput').value='';
  nxRemoveDMImage(); // clear pending attachments
  nxDMTyping();
  nxBringToFront('dmScreen');
  $('dmScreen').style.display='flex';
  $('bnav').classList.add('kb-hidden');
  nxStopChatListPoll(); // no need to poll chat list while a DM thread is open
  nxStartDMPoll(peerKey); // polling fallback for instant message sync

  // Hide both badges initially
  const verBadgeEl=$('dmPeerVerifiedBadge');
  const goldBadgeEl=$('dmPeerGoldBadge');
  if(verBadgeEl) verBadgeEl.style.display='none';
  if(goldBadgeEl) goldBadgeEl.style.display='none';

  // INSTANT PAINT: if we already have this thread's messages in memory
  // (preloaded at app start, or from a previous open this session), render
  // them immediately — no spinner, no blank screen — exactly like opening
  // a thread you've already opened before in Instagram. Only fall back to
  // skeleton bubbles when there is truly nothing to show yet.
  const cachedChat=_cache.chatList.find(c=>c.peer.student_key===peerKey);
  if(cachedChat && cachedChat.messages && cachedChat.messages.length){
    nxRenderDMMessages(cachedChat.messages);
  } else {
    // Shimmer bubble skeletons — feels alive instead of a blank "Loading…"
    const dmSkel = (side)=>`<div class="dm-skel-wrap"><div class="af-skel dm-skel-bubble ${side}"></div></div>`;
    $('dmMessages').innerHTML =
      dmSkel('peer') + dmSkel('me') + dmSkel('peer') +
      dmSkel('me') + dmSkel('peer') + dmSkel('me');
  }

  // Paint the header instantly from any cached profile thumbnail too.
  const cachedProf = _cache.profiles.get(peerKey);
  if(cachedProf) _applyDMHeaderProfile(cachedProf);

  // fetch_dms and get_profile are independent reads — run them in
  // parallel instead of one after another so the round-trip cost is
  // max(a,b) instead of a+b.
  const [res, profRes] = await Promise.all([
    edgeCall({action:'fetch_dms',peer_key:peerKey}),
    edgeCall({action:'get_profile',target_key:peerKey}),
  ]);
  const msgs=res&&res.ok&&res.messages?res.messages:[];

  // Check block status (Requires edge function to return am_i_blocked in fetch_dms)
  const amIBlocked = !!(res && res.am_i_blocked);
  const iBlockedThem = _cache.blockedKeys.has(peerKey);

  if (iBlockedThem) {
    show('dmBlockedBanner');
    $('dmBlockedBanner').textContent = 'You have blocked this user.';
    $('dmInput').disabled = true;
    $('dmSendBtn').disabled = true;
    $('dmImageInput').disabled = true;
  } else if (amIBlocked) {
    show('dmBlockedBanner');
    $('dmBlockedBanner').textContent = 'You cannot send messages to this user.';
    $('dmInput').disabled = true;
    $('dmSendBtn').disabled = true;
    $('dmImageInput').disabled = true;
  } else {
    hide('dmBlockedBanner');
    $('dmInput').disabled = false;
    $('dmImageInput').disabled = false;
  }
  nxApplyDMAttachGate();

  if(res && res.peer_presence){
    _cache.presence[peerKey] = res.peer_presence;
    nxRenderChatList();
  }
  if(profRes&&profRes.ok&&profRes.profile){
    const p=profRes.profile;
    _cache.profiles.set(peerKey, p);
    _applyDMHeaderProfile(p, res && res.peer_presence);
  }

  // Capture peer's read receipt if server returned one
  if(res && res.peer_read_at) _dmPeerReadAt=res.peer_read_at;

  // Only re-render if the thread is still open on this peer (guards
  // against a race if the user backed out before the network resolved)
  // and only if we got a real response — never blow away the instantly
  // painted cached messages with an empty array from a failed/blocked call.
  if(_dmPeer && _dmPeer.key===peerKey && res && res.ok){
    nxRenderDMMessages(msgs);
  }
  markChatRead(peerKey);
  // Signal to the server that we've read this thread (read receipt)
  edgeCall({action:'mark_dm_read',peer_key:peerKey}).catch(()=>{});
}

function _applyDMHeaderProfile(p, pres){
  const isVer=!!p.is_verified;
  const av=$('dmPeerAvatar');
  if(p.avatar_url){
    av.className='avatar avatar-sm'+(isVer?' gold-avatar-frame':'');
    av.innerHTML=`<img src="${esc(p.avatar_url)}" style="width:100%;height:100%;object-fit:cover;border-radius:9px;" loading="lazy"/>`;
  } else {
    av.className='avatar avatar-sm'+(p.emoji?'':' initials')+(isVer?' gold-avatar-frame':'');
    av.textContent=p.emoji||initials(p.student_name);
  }

  // Show gold badge for verified in DM header
  const goldBadgeEl=$('dmPeerGoldBadge');
  const verBadgeEl=$('dmPeerVerifiedBadge');
  if(isVer){
    if(goldBadgeEl) goldBadgeEl.style.display='inline-flex';
    if(verBadgeEl) verBadgeEl.style.display='none';
  } else {
    if(goldBadgeEl) goldBadgeEl.style.display='none';
    if(verBadgeEl) verBadgeEl.style.display='none';
  }

  // Presence status in DM header (overrides role string when available)
  const statusEl=$('dmHdrStatus');
  const presInfo=pres ? formatPresence(pres) : null;
  if(presInfo){
    if(presInfo.online){
      statusEl.innerHTML='<span class="presence-online" style="font-size:12px;">Active now</span>';
      statusEl.style.color='';
    } else {
      statusEl.textContent=presInfo.label;
      statusEl.style.color='var(--tm)';
    }
  } else {
    let roleStr='Community Member';
    if(isVer) roleStr='Premium Verified Member';
    else if(p.username) roleStr='@'+p.username;
    statusEl.textContent=roleStr;
    statusEl.style.color=isVer?'var(--gold)':'var(--tm)';
  }
  $('dmHdr').className='dm-hdr '+(isVer?'gold-chat-hdr':'');
  // Update local peer reference with full profile
  if(_dmPeer) _dmPeer.isVerified=isVer;
}

function nxOpenProfileFromDM(){
  if(!_dmPeer) return;
  nxOpenProfile(_dmPeer.key,_dmPeer.name);
}
function nxCloseDM(){
  $('dmScreen').style.display='none';
  $('bnav').classList.remove('kb-hidden');
  nxStopTypingSignal();       // stop broadcasting our typing state
  nxClearPeerTyping();        // clear peer typing timer and indicator
  _dmPeer=null; _dmEditingId=null;
  nxRemoveDMImage();
  nxStopDMPoll();
  if(_activeTab==='chats') nxStartChatListPoll(); // resume chat list polling now that DM is closed
  nxForceRepaint();
}

