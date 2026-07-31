/* ═══════════════════════════════════════════════════
   TAB SWITCH
═══════════════════════════════════════════════════ */
function nxSwitchTab(tab){
  if(_activeTab==='feed' && $('feed')) _cache.feedScrollTop = $('feed').scrollTop;

  _activeTab = tab;
  if($('tabFeed')) $('tabFeed').classList.toggle('active', tab==='feed');
  if($('tabChats')) $('tabChats').classList.toggle('active', tab==='chats');
  if(window.nxSetNavActive) window.nxSetNavActive(tab);

  if(tab==='feed'){
    show('feed');
    hide('chatsTab');
    requestAnimationFrame(()=>{ if($('feed')) $('feed').scrollTop = _cache.feedScrollTop; });
    nxStopChatListPoll();
    nxUpdateUnreadBadge();
    return;
  }

  hide('feed');
  show('chatsTab');
  _newWhileFeed.clear();
  nxRenderChatList();
  nxUpdateUnreadBadge();
  nxStartChatListPoll();
}

/* ═══════════════════════════════════════════════════
   INIT
═══════════════════════════════════════════════════ */
async function init(){
  loadSupabaseSDK();
  syncAvatarBtn();
  syncTheme();

  if(!isLoggedIn()){
    goToLogin();
    return;
  }

  if(window.afAuth && typeof window.afAuth.enterApp==='function') window.afAuth.enterApp();
  else document.body.classList.remove('gate-active');

  show('mainView');
  _cache.chatReadTs = loadChatReadTs();
  _cache.likedPostIds = loadLikedPostIds();
  nxRequestNotifyPermission();
  nxLoadMyProfile();
  await Promise.all([nxLoadPosts(), nxPreloadConnections(), nxLoadBlockedUsers()]);
  nxLoadStories();
  setupRealtime();
  startPresencePing();
  syncMyStoryAvatar();
  nxStartChatListPoll();
}

/* ═══════════════════════════════════════════════════
   CONNECTIONS & CHAT CACHE
═══════════════════════════════════════════════════ */
async function nxPreloadConnections(){
  // Paint instantly from cached connections (if any) before the network
  // round-trip resolves, then quietly refresh in the background.
  const cachedFollowers=loadSnapshot('followers_me');
  const cachedFollowing=loadSnapshot('following_me');
  if(Array.isArray(cachedFollowers)) _cache.myFollowers=cachedFollowers;
  if(Array.isArray(cachedFollowing)){
    _cache.myFollowing=cachedFollowing;
    _cache.followingKeys=new Set(_cache.myFollowing.map(u=>String(u.student_key||'')));
  }
  // Paint the cached chat list immediately (no network call) — the real
  // fetch below will quietly replace it once it resolves.
  if(!_cache.chatList.length){
    const cachedChats=loadSnapshot('chats');
    if(Array.isArray(cachedChats) && cachedChats.length){
      _cache.chatList=cachedChats;
      nxRenderChatList();
    }
  }

  // get_followers and get_following are independent — fetch them in
  // parallel instead of one after another.
  const [folRes, figRes] = await Promise.all([
    edgeCall({action:'get_followers',target_key:sKey()}),
    edgeCall({action:'get_following',target_key:sKey()}),
  ]);
  if(folRes&&folRes.ok){
    _cache.myFollowers = folRes.users||[];
    saveSnapshot('followers_me', _cache.myFollowers);
  }
  if(figRes&&figRes.ok){
    _cache.myFollowing = figRes.users||[];
    _cache.followingKeys = new Set(_cache.myFollowing.map(u=>String(u.student_key||'')));
    saveSnapshot('following_me', _cache.myFollowing);
  }
  nxUpdatePendingFollowsBadge(); // update badge now that follow data is fresh
  await nxLoadChatsFromConnections();
}

async function nxLoadChatsFromConnections(){
  const res=await edgeCall({action:'get_chat_list'});
  if(!res||!res.ok) return;
  _cache.chatList=res.chats||[];
  _chatsLoaded=true;
  nxRenderChatList();
  // Persist so the NEXT app open can paint this chat list instantly
  // from cache before the network round-trip resolves (same pattern
  // as the feed/connections snapshots above).
  saveSnapshot('chats',_cache.chatList);
  // Fetch online/last-seen status for all chat peers and re-render
  nxFetchPresenceForChats();
}

/* ═══════════════════════════════════════════════════
   CHAT UNREAD (in-memory read timestamps)
═══════════════════════════════════════════════════ */
function getChatUnreadCount(messages){
  if(!messages||!messages.length) return 0;
  const peerKey=messages.find(m=>m.sender!==sKey())?.sender;
  if(!peerKey) return 0;
  const lastRead=_cache.chatReadTs.get(peerKey)||0;
  return messages.filter(m=>m.sender===peerKey&&new Date(m.ts).getTime()>lastRead).length;
}
function markChatRead(peerKey){
  _cache.chatReadTs.set(peerKey, Date.now());
  saveChatReadTs();
  nxUpdateUnreadBadge();
  nxRenderChatList();
}
function nxUpdateUnreadBadge(){
  let total=0;
  _cache.chatList.forEach(c=>{total+=getChatUnreadCount(c.messages);});
  const badge=$('chatBadge');
  if(badge){
    badge.textContent = total>9 ? '9+ new' : (total+' new');
    // FIX v64: never show the badge while the user is already viewing the chats tab
    badge.classList.toggle('hidden', total===0 || _activeTab==='chats');
  }
}

/* ═══════════════════════════════════════════════════
   REALTIME
═══════════════════════════════════════════════════ */
let _realtimeChannel=null;
let _realtimePostsChannel=null;
let _presencePingTimer=null;

// Tracks which peer keys sent messages while the user was on the feed tab
const _newWhileFeed = new Set();
// Tracks the last message timestamp we rendered per peer — used to detect truly new arrivals
const _peerLastMsgTs = new Map();

function startPresencePing(){
  // Ping every 60s to keep online status fresh
  edgeCall({action:'ping_presence'}).catch(()=>{});
  _presencePingTimer=setInterval(()=>{
    edgeCall({action:'ping_presence'}).catch(()=>{});
  },60000);
}

function setupRealtime(){
  const sb=getSb();
  if(!sb) return;

  // DM realtime (instant delivery)
  _realtimeChannel=sb.channel('realtime_dms')
    .on('postgres_changes',{event:'INSERT',schema:'public',table:'af_nexus_dms_v2'},payload=>{
      const msg=payload.new;
      if(msg&&(msg.receiver_key===sKey()||msg.sender_key===sKey())){
        const peerKey=msg.sender_key===sKey()?msg.receiver_key:msg.sender_key;
        nxRefreshPeerChat(peerKey);
      }
    })
    .on('postgres_changes',{event:'UPDATE',schema:'public',table:'af_nexus_dms_v2'},payload=>{
      const msg=payload.new;
      if(msg&&(msg.receiver_key===sKey()||msg.sender_key===sKey())){
        const peerKey=msg.sender_key===sKey()?msg.receiver_key:msg.sender_key;
        nxRefreshPeerChat(peerKey);
      }
    })
    .subscribe();

  // Posts realtime (new posts appear instantly)
  _realtimePostsChannel=sb.channel('realtime_posts')
    .on('postgres_changes',{event:'INSERT',schema:'public',table:'af_nexus_posts_v2'},_payload=>{
      // Debounce: don't re-fetch if we just posted ourselves
      clearTimeout(_postRefreshDebounce);
      _postRefreshDebounce=setTimeout(()=>{
        if(_activeTab==='feed' && $('mainView').classList.contains('active')){
          nxLoadPosts(true);
        }
      },800);
    })
    .subscribe();

  // Stories realtime — debounced so a burst of posts triggers only one re-fetch
  sb.channel('realtime_stories')
    .on('postgres_changes',{event:'INSERT',schema:'public',table:'af_nexus_stories_v1'},payload=>{
      if(payload.new && String(payload.new.student_key) === String(sKey())) return;
      clearTimeout(_storyRefreshDebounce);
      _storyRefreshDebounce=setTimeout(()=>nxLoadStories(), 800);
    })
    .subscribe();
}
let _postRefreshDebounce=null;
let _storyRefreshDebounce=null;

function teardownRealtime(){
  const sb=getSb();
  if(sb){
    try{ if(_realtimeChannel) sb.removeChannel(_realtimeChannel); }catch(e){}
    try{ if(_realtimePostsChannel) sb.removeChannel(_realtimePostsChannel); }catch(e){}
  }
  _realtimeChannel=null;
  _realtimePostsChannel=null;
  clearInterval(_presencePingTimer);
}

const _refreshInFlight=new Set(); // de-dupe: skip if a fetch for this peer is already running
async function nxRefreshPeerChat(peerKey){
  if(_refreshInFlight.has(peerKey)) return; // realtime + poll fired simultaneously — skip dupe
  _refreshInFlight.add(peerKey);
  let res;
  try{ res=await edgeCall({action:'fetch_dms',peer_key:peerKey}); }
  finally{ _refreshInFlight.delete(peerKey); }
  if(!res) return;
  if(res&&res.ok&&res.messages){
    let chatIdx=_cache.chatList.findIndex(c=>c.peer.student_key===peerKey);
    if(chatIdx>=0){
      _cache.chatList[chatIdx].messages=res.messages;
      _cache.chatList[chatIdx].latest=res.messages[res.messages.length-1];
    } else {
      const profRes=await edgeCall({action:'get_profile',target_key:peerKey});
      if(profRes&&profRes.ok&&profRes.profile&&res.messages.length>0){
        _cache.chatList.push({peer:profRes.profile,messages:res.messages,latest:res.messages[res.messages.length-1]});
        _cache.profiles.set(peerKey, profRes.profile);
      }
    }
    _cache.chatList.sort((a,b)=>new Date(b.latest.ts)-new Date(a.latest.ts));
    nxRenderChatList(); // always keep chat list in sync
    nxUpdateUnreadBadge();
    if($('dmScreen').style.display==='flex'&&_dmPeer&&_dmPeer.key===peerKey){
      if(res.peer_read_at) _dmPeerReadAt=res.peer_read_at;
      nxRenderDMMessages(res.messages);
      markChatRead(peerKey);
      // Show or clear the typing indicator based on the server response
      if(res.peer_is_typing) nxShowPeerTyping();
    } else {
      // Detect genuinely NEW messages (not already seen before this poll)
      const latest=res.messages&&res.messages[res.messages.length-1];
      if(latest && latest.sender!==sKey()){
        const newTs=new Date(latest.ts).getTime();
        const prevTs=_peerLastMsgTs.get(peerKey)||0;
        if(newTs > prevTs){
          // FIX v64: only mark as "new" and toast when user is NOT on chats tab
          // (no notification needed if they're already looking at the chat list)
          if(_activeTab !== 'chats'){
            _newWhileFeed.add(peerKey);
          nxRenderChatList(); // re-render to show the pulsing dot
          const peerObj=_cache.chatList.find(c=>c.peer.student_key===peerKey)?.peer;
          const name=peerObj?.student_name||'Someone';
          const rawPreview = latest.text||'';
          const STORY_REPLY_PREFIX = '\u21A9 Replied to your story:\n';
          const replyMatchPrev = rawPreview.match(_DM_REPLY_RE);
          const cleanPreview = replyMatchPrev ? replyMatchPrev[3] : rawPreview;
          const displayText = cleanPreview.startsWith(STORY_REPLY_PREFIX)
            ? '↩ Replied to your story'
            : (cleanPreview.length>40 ? cleanPreview.slice(0,40)+'…' : cleanPreview) || '📷 Image';
          showToast(`💬 ${name}: ${displayText}`,'info');
          // Push notification when tab is hidden or unfocused
          nxPushNotify(name, displayText, peerObj?.avatar_url||'');
          } // end if(_activeTab !== 'chats')
        }
      }
      // Always record the latest timestamp we've seen for this peer
      if(latest) _peerLastMsgTs.set(peerKey, new Date(latest.ts).getTime());
    }
  }
}

/* ═══════════════════════════════════════════════════
   PUSH NOTIFICATIONS (Web Notifications API)
   Only fires when the tab is hidden or not focused.
   Permission is requested once per session after login.
═══════════════════════════════════════════════════ */
function nxRequestNotifyPermission(){
  if(!('Notification' in window)) return;
  if(Notification.permission==='default'){
    // Use a gentle user-gesture-independent request; most browsers
    // allow this on page load if the user has interacted previously.
    Notification.requestPermission().catch(()=>{});
  }
}

function nxPushNotify(senderName, bodyText, iconUrl){
  if(!('Notification' in window)) return;
  if(Notification.permission!=='granted') return;
  // Only fire when tab is hidden OR the window doesn't have focus
  if(!document.hidden && document.hasFocus()) return;
  try{
    const opts={
      body: bodyText,
      icon: iconUrl||undefined,
      badge: iconUrl||undefined,
      tag: 'af-nexus-dm',   // replace previous notification from same app
      renotify: true,        // still alert even if same tag
      silent: false,
    };
    const n=new Notification(`💬 ${senderName}`, opts);
    // Clicking the notification focuses the tab
    n.onclick=()=>{
      window.focus();
      n.close();
    };
    // Auto-close after 6 seconds
    setTimeout(()=>n.close(), 6000);
  }catch(e){/* Notification API can throw in certain contexts */}
}

/* ── Global background chat poll (fallback when realtime is unavailable) ── */
let _globalChatPollTimer=null;
function startGlobalChatPoll(){
  stopGlobalChatPoll();
  _globalChatPollTimer=setInterval(async()=>{
    if(!isLoggedIn()) return;
    const peers=_cache.chatList.slice(0,6).map(c=>c.peer?.student_key).filter(Boolean);
    if(!peers.length) return;
    await Promise.all(peers.map(pk=>nxRefreshPeerChat(pk)));
  }, 8000); // FIX v64: 8 s for faster feel without hammering the server
}
function stopGlobalChatPoll(){
  clearInterval(_globalChatPollTimer);
  _globalChatPollTimer=null;
}

/* ═══════════════════════════════════════════════════
   MY PROFILE (lightweight — reads from localStorage)
═══════════════════════════════════════════════════ */
async function nxLoadMyProfile(){
  const res=await edgeCall({action:'get_my_profile'});
  if(res&&res.ok&&res.profile){
    if(res.profile.username) localStorage.setItem('af_username',res.profile.username);
    if(res.profile.emoji)    localStorage.setItem('af_avatar_emoji',res.profile.emoji);
    if(res.profile.avatar_url) localStorage.setItem('af_avatar_url',res.profile.avatar_url);
    _cache.myVerified = !!res.profile.is_verified;
    syncAvatarBtn();
  }
  const hasUsername=!!(res&&res.ok&&res.profile&&res.profile.username);
  $('usernameBanner').classList.toggle('hidden',hasUsername);
}

/* ═══════════════════════════════════════════════════
   FEED LOAD & RANKING
═══════════════════════════════════════════════════ */
async function nxLoadPosts(isRefresh=false){
  if(!isLoggedIn()){init();return;}

  // Instant paint from the last cached feed snapshot (stale-while-revalidate,
  // same pattern Instagram/Facebook use) — show something real immediately
  // instead of a skeleton whenever we have a previous snapshot to show.
  if(!isRefresh && !_cache.posts.length){
    const cachedFeed=loadSnapshot('feed_'+_mode);
    if(Array.isArray(cachedFeed) && cachedFeed.length){
      _cache.posts=cachedFeed;
      renderListToContainer(_cache.posts, 'postsList', true);
    } else {
      // Rich Instagram-style skeleton cards — mimic real card shape so layout doesn't jump
      const postSkelCard = `
        <div class="post-card" style="pointer-events:none;">
          <div class="post-top" style="gap:10px;">
            <div class="af-skel af-skel-circle" style="width:36px;height:36px;"></div>
            <div style="flex:1;display:flex;flex-direction:column;gap:6px;justify-content:center;">
              <div class="af-skel af-skel-line" style="width:44%;"></div>
              <div class="af-skel af-skel-line" style="width:28%;height:8px;"></div>
            </div>
          </div>
          <div class="af-skel af-skel-line" style="width:92%;margin:10px 0 4px;"></div>
          <div class="af-skel af-skel-line" style="width:75%;"></div>
          <div class="af-skel" style="height:180px;border-radius:12px;margin:10px 0;"></div>
          <div style="display:flex;gap:16px;padding:6px 0;">
            <div class="af-skel af-skel-line" style="width:52px;height:28px;border-radius:20px;margin:0;"></div>
            <div class="af-skel af-skel-line" style="width:52px;height:28px;border-radius:20px;margin:0;"></div>
          </div>
        </div>`;
      $('postsList').innerHTML = postSkelCard + postSkelCard + postSkelCard;
    }
  }

  const res=await edgeCall({action:'fetch_posts',mode:_mode});
  if(!res||!res.ok){
    if(!_cache.posts.length){
      $('postsList').innerHTML='<div class="state-msg"><span>😕</span><span>Could not load posts.</span></div>';
    }
    return;
  }

  const freshPosts=Array.isArray(res.posts)?res.posts:[];

  // Sync liked state from server when it's actually provided.
  // The edge function currently never returns liked_post_ids / is_liked,
  // so in that case we keep the locally-persisted set (loaded at init)
  // instead of wiping it back to empty on every load/refresh.
  if(Array.isArray(res.liked_post_ids)){
    _cache.likedPostIds = new Set(res.liked_post_ids);
    saveLikedPostIds();
  } else if(freshPosts.some(p=>p.is_liked)){
    _cache.likedPostIds = new Set(freshPosts.filter(p=>p.is_liked).map(p=>p.id));
    saveLikedPostIds();
  }

  // Rank: on refresh, merge intelligently; on first load just rank
  if(isRefresh && _cache.posts.length > 0){
    _cache.posts = mergeFeedOnRefresh(_cache.posts, freshPosts, _cache.followingKeys);
  } else {
    _cache.posts = rankFeed(freshPosts, _cache.followingKeys);
  }

  _cache.feedLastRefresh = Date.now();
  saveSnapshot('feed_'+_mode, _cache.posts);
  renderListToContainer(_cache.posts, 'postsList', true);
}

async function nxRefreshGlobal(){
  if(_activeTab==='chats'){await nxLoadChatsFromConnections();return;}
  // Save scroll position
  _cache.feedScrollTop = $('feed').scrollTop;
  await nxLoadPosts(true); // isRefresh=true for smart merge
  // Restore scroll position after render
  requestAnimationFrame(()=>{ $('feed').scrollTop = _cache.feedScrollTop; });
  if($('profileScreen').style.display==='flex'&&_profileData){
    nxLoadProfileMeta(_profileData.key);
    nxLoadProfilePosts(_profileData.key);
  }
}

function nxSetMode(m){
  _mode=m==='recent'?'recent':'relevant';
  $('pillRelevant').classList.toggle('active',_mode==='relevant');
  $('pillRecent').classList.toggle('active',_mode==='recent');
  nxLoadPosts(false);
}

