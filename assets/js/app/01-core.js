/* ═══════════════════════════════════════════════════
   CONSTANTS & CONFIG
═══════════════════════════════════════════════════ */
const STUDENT_URL   = "https://afooyyydhlwngzssgqih.supabase.co";
const STUDENT_KEY_SB = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFmb295eXlkaGx3bmd6c3NncWloIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg2NDQxMjgsImV4cCI6MjA5NDIyMDEyOH0.KG0XO0oP_2MpewHoIwTtbrKg5FkyOYRUtVzLH1MSJiE";
const ADMIN_KEYS = ['admin@academeforge.in'];

/* ═══════════════════════════════════════════════════
   IN-MEMORY CACHE  (no localStorage for runtime data)
   Only identity keys (email/name/emoji/avatar/dark)
   come from localStorage — everything else lives here.
═══════════════════════════════════════════════════ */
/* ═══════════════════════════════════════════════════
   CHAT READ-STATE PERSISTENCE
   chatReadTs lives in-memory for fast lookups during the
   session, but is mirrored to localStorage (scoped to the
   current account) so a chat that was already seen stays
   marked as read after a page reload — the red unread dot
   should never reappear for a message the user has opened.
═══════════════════════════════════════════════════ */
function chatReadTsStorageKey(){
  const key=sKey();
  return key ? 'af_chat_read_ts:'+key : null;
}
function loadChatReadTs(){
  const storageKey=chatReadTsStorageKey();
  if(!storageKey) return new Map();
  try{
    const raw=localStorage.getItem(storageKey);
    if(!raw) return new Map();
    const obj=JSON.parse(raw);
    return new Map(Object.entries(obj).map(([k,v])=>[k,Number(v)||0]));
  }catch(e){ return new Map(); }
}
function saveChatReadTs(){
  const storageKey=chatReadTsStorageKey();
  if(!storageKey) return;
  try{
    const obj={};
    _cache.chatReadTs.forEach((v,k)=>{ obj[k]=v; });
    localStorage.setItem(storageKey, JSON.stringify(obj));
  }catch(e){ /* storage full or unavailable — read-state just won't persist this time */ }
}

/* ═══════════════════════════════════════════════════
   GENERIC "STALE-WHILE-REVALIDATE" SNAPSHOT CACHE
   This is the same fetch pattern big apps (Instagram,
   Facebook, etc.) use: the last successful response for
   feed / chats / followers / following is mirrored to
   localStorage (scoped to the current account). On the
   next app open we paint that snapshot INSTANTLY — no
   spinner, no blank screen — while the real network
   request runs quietly in the background and silently
   replaces it once it resolves. Nothing here changes what
   is rendered or how — only when data first appears.
═══════════════════════════════════════════════════ */
function snapshotStorageKey(name){
  const key=sKey();
  return key ? 'af_snap_'+name+':'+key : null;
}
function loadSnapshot(name){
  const storageKey=snapshotStorageKey(name);
  if(!storageKey) return null;
  try{
    const raw=localStorage.getItem(storageKey);
    return raw ? JSON.parse(raw) : null;
  }catch(e){ return null; }
}
function saveSnapshot(name, data){
  const storageKey=snapshotStorageKey(name);
  if(!storageKey) return;
  try{
    localStorage.setItem(storageKey, JSON.stringify(data));
  }catch(e){ /* storage full or unavailable — just skip caching this time */ }
}

const _cache = {
  /* Feed */
  posts: [],               // current ranked feed
  seenPostIds: new Map(),  // postId -> {count, ts, duration}
  feedScrollTop: 0,
  feedLastRefresh: 0,
  feedMode: 'relevant',

  /* Connections */
  myFollowers: [],
  myFollowing: [],
  followingKeys: new Set(),

  /* Chats */
  chatList: [],            // [{peer, messages, latest}]
  chatReadTs: new Map(),   // peerKey -> lastReadTimestamp (persisted, see above)

  /* Profile thumbnails keyed by student_key */
  profiles: new Map(),     // student_key -> {name, emoji, avatar_url, is_verified, username, bio}

  /* Liked post IDs this session */
  likedPostIds: new Set(),
  blockedKeys: new Set(),

  /* Presence: student_key -> {is_online, last_seen_at} */
  presence: {},

  /* Misc */
  myVerified: false,
  notifications: [],
  notifiedFollowerKeys: new Set(),
  notifiedMessageKeys: new Set(),
};

/* ═══════════════════════════════════════════════════
   SUPABASE BOOTSTRAP
═══════════════════════════════════════════════════ */
let _sb = null;
let _sbLoadPromise = null; // cached — prevents concurrent calls each injecting a new <script>
function loadSupabaseSDK(){
  if(_sbLoadPromise) return _sbLoadPromise;
  _sbLoadPromise = new Promise((res,rej)=>{
    if(typeof supabase!=='undefined'){res();return;}
    const s=document.createElement('script');
    s.src='https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2';
    s.onload=res;
    s.onerror=()=>{ _sbLoadPromise=null; rej(new Error('Supabase SDK failed.')); };
    document.head.appendChild(s);
  });
  return _sbLoadPromise;
}
function getSb(){
  if(_sb) return _sb;
  if(typeof supabase!=='undefined') _sb=supabase.createClient(STUDENT_URL,STUDENT_KEY_SB);
  return _sb;
}

/* ═══════════════════════════════════════════════════
   HELPERS
═══════════════════════════════════════════════════ */
const $    = id => document.getElementById(id);
const show = id => $(id)&&$(id).classList.remove('hidden');
const hide = id => $(id)&&$(id).classList.add('hidden');

/* ═══════════════════════════════════════════════════
   STACKING MANAGER
   Every full-screen view (profile, my-profile, DM, search)
   and every modal overlay (comments, follow list, etc.)
   gets bumped to the top of the visual stack the moment
   it opens, regardless of which other screen/modal it was
   opened from. This guarantees that clicking a name inside
   a DM, inside the comments modal, or inside a follow list
   always opens the profile screen IN FRONT of whatever is
   currently open — never behind it.
═══════════════════════════════════════════════════ */
const STACK_BASE_Z = 1100;
let _stackCounter = 0;
function nxBringToFront(id){
  const el=$(id); if(!el) return;
  _stackCounter+=1;
  el.style.zIndex = String(STACK_BASE_Z + _stackCounter);
}
const isLoggedIn = ()=>!!(localStorage.getItem('af_student_email')||localStorage.getItem('af_student_mobile'));
const sKey  = ()=>localStorage.getItem('af_student_email')||localStorage.getItem('af_student_mobile')||'';
const sName = ()=>localStorage.getItem('af_student_name')||'Student';
const isAdmin = ()=>ADMIN_KEYS.includes(sKey());

function wordCount(t){const s=String(t||'').trim();return s?s.split(/\s+/).filter(Boolean).length:0;}
function initials(n){return String(n||'AF').trim().split(/\s+/).slice(0,2).map(v=>v.charAt(0).toUpperCase()).join('');}
function esc(t){return String(t||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
function timeAgo(v){
  if(!v) return '';
  try{
    const d=Math.floor((Date.now()-new Date(v).getTime())/1000);
    if(d<60) return 'just now';
    if(d<3600) return Math.floor(d/60)+'m';
    if(d<86400) return Math.floor(d/3600)+'h';
    if(d<604800) return Math.floor(d/86400)+'d';
    return new Date(v).toLocaleDateString();
  }catch(e){return '';}
}
function getMyEmoji(){return localStorage.getItem('af_avatar_emoji')||'';}
function getMyUsername(){return localStorage.getItem('af_username')||'';}
function getMyAvatarUrl(){return localStorage.getItem('af_avatar_url')||'';}

/* ═══════════════════════════════════════════════════
   THEME
═══════════════════════════════════════════════════ */
function getThemeMode(){
  return localStorage.getItem('af_theme_mode') || (localStorage.getItem('af_dark_mode')==='1' ? 'dark' : 'system');
}
function syncTheme(){
  const mode = getThemeMode();
  const systemDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  const dark = mode==='dark' || (mode==='system' && systemDark);
  document.documentElement.setAttribute('data-theme', dark?'dark':'light');
  const sel=$('themeModeSelect');
  if(sel) sel.value=mode;
}
syncTheme();
window.addEventListener('storage',e=>{
  if(e.key==='af_dark_mode'||e.key==='af_theme_mode') syncTheme();
  if(['af_student_email','af_student_mobile','af_student_name'].includes(e.key)){
    const stillLoggedIn = !!(localStorage.getItem('af_student_email')||localStorage.getItem('af_student_mobile'));
    if(!stillLoggedIn){
      // Logout happened in another tab/page (e.g. the Settings page) —
      // purge every cache so nothing from the previous session lingers.
      nxClearAllCaches();
    }
    init();
  }
});
if(window.matchMedia){
  try{ window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', syncTheme); }catch(e){}
}
function nxSetThemeMode(mode){
  const next=['system','dark','light'].includes(mode)?mode:'system';
  localStorage.setItem('af_theme_mode', next);
  localStorage.setItem('af_dark_mode', next==='dark'?'1':'0');
  syncTheme();
}
function nxToggleDarkMode(){
  nxSetThemeMode(document.documentElement.getAttribute('data-theme')==='dark'?'light':'dark');
}
window.nxToggleDarkMode = nxToggleDarkMode;
window.nxSetThemeMode = nxSetThemeMode;
function goToLogin(){
  sessionStorage.setItem('af_last_tab','student');
  if(window.afAuth && typeof window.afAuth.enterGate==='function'){
    window.afAuth.enterGate();
    return;
  }
  document.body.classList.add('gate-active');
  hide('mainView');
}

/**
 * Fully logs the student out of JB Knowledge Park and wipes every trace of their
 * session from this page before redirecting:
 * 1. Removes every af_* identity/profile key from localStorage
 * (email, mobile, name, username, bio, avatar, dark mode is kept
 * since theme is a device preference, not account data — change
 * AF_KEEP_ON_LOGOUT below if you want theme reset too).
 * 2. Clears sessionStorage entries set by this page.
 * 3. Empties the entire in-memory _cache object (feed, profiles,
 * chats, likes, follow graph) so nothing the next person who
 * opens this device could see leftover data from this account.
 * 4. Resets all module-level UI state variables.
 * 5. Unsubscribes the realtime DM channel tied to this account.
 * 6. Closes every open screen/modal so the next init() starts clean.
 */
const AF_KEEP_ON_LOGOUT = new Set();
function nxClearAllCaches(){
  // 1. Wipe app keys from localStorage and sessionStorage.
  Object.keys(localStorage)
    .filter(k=>k.startsWith('af_') && !AF_KEEP_ON_LOGOUT.has(k))
    .forEach(k=>localStorage.removeItem(k));

  Object.keys(sessionStorage)
    .filter(k=>k.startsWith('af_'))
    .forEach(k=>sessionStorage.removeItem(k));

  // 3. Empty the in-memory cache completely (new objects, not just .clear())
  //    to guarantee no stale references survive in closures.
  _cache.posts = [];
  _cache.seenPostIds = new Map();
  _cache.feedScrollTop = 0;
  _cache.feedLastRefresh = 0;
  _cache.feedMode = 'relevant';
  _cache.myFollowers = [];
  _cache.myFollowing = [];
  _cache.followingKeys = new Set();
  _cache.chatList = [];
  _cache.chatReadTs = new Map();
  _cache.profiles = new Map();
  _cache.likedPostIds = new Set();
  _cache.blockedKeys = new Set();
  _cache.myVerified = false;
  _cache.notifications = [];
  _cache.notifiedFollowerKeys = new Set();
  _cache.notifiedMessageKeys = new Set();

  // 4. Reset module-level state
  _activeTab='feed';
  _mode='relevant';
  _curPostId=null; _replyParentId=null; _menuTarget=null;
  _profileData=null; _profileIsFollowing=false;
  _dmPeer=null; _dmEditingId=null;
  _reportPostId=null; _reportReason=null;
  _pendingAvatarDataUrl=null;
  _dmPendingImage=null;
  _stackCounter=0;

  // 5. Tear down realtime subscription bound to this account
  teardownRealtime();

  // 6. Close every screen/modal so nothing from this session lingers visibly
  ['profileScreen','myProfileScreen','dmScreen','searchScreen',
   'followListModal','editProfileModal','composerModal','commentsModal',
   'replyModal','reportModal','menuModal','dmOptionsModal','clearChatModal',
   'mainMenuModal','blockListModal'].forEach(id=>{
    const el=$(id); if(el) el.style.display='none';
  });
}
async function nxClearBrowserCaches(){
  try{
    if('caches' in window){
      const names=await caches.keys();
      await Promise.all(names.map(n=>caches.delete(n)));
    }
  }catch(e){}
  try{
    if(indexedDB && indexedDB.databases){
      const dbs=await indexedDB.databases();
      await Promise.all((dbs||[]).filter(db=>db.name).map(db=>new Promise(resolve=>{
        const req=indexedDB.deleteDatabase(db.name);
        req.onsuccess=req.onerror=req.onblocked=()=>resolve();
      })));
    } else if(indexedDB){
      ['af_story_video_cache_v1'].forEach(name=>{
        try{ indexedDB.deleteDatabase(name); }catch(e){}
      });
    }
  }catch(e){}
}
async function nxLogout(){
  nxClearAllCaches();
  await nxClearBrowserCaches();
  goToLogin();
}
window.nxLogout = nxLogout;
window.nxClearAllCaches = nxClearAllCaches;

/* ═══════════════════════════════════════════════════
   EDGE CALL
   NOTE: User-facing messages are intentionally generic.
   Raw SDK / transport / edge-function error text (e.g. "Edge
   Function returned a non-2xx status code", "FunctionsHttpError",
   HTTP 5xx status text, etc.) must NEVER reach the UI — it is
   internal plumbing detail that means nothing to the end user
   and looks broken/unprofessional. We classify the failure into
   one of three buckets (offline / network / server) and return
   a calm, professional message for each. Genuine application-level
   messages returned by our own backend in `data.message` (when
   `data.ok` is false) are still passed through as-is, since those
   are intentional, human-written responses from our own API
   (e.g. validation errors), not provider plumbing.
═══════════════════════════════════════════════════ */
const EDGE_ERR_OFFLINE = "You're offline right now. Please check your internet connection and try again.";
const EDGE_ERR_NETWORK = "We couldn't reach the server. Please check your connection and try again.";
const EDGE_ERR_SERVER  = "Something went wrong on our end. It's not you — we're already looking into it. Please try again shortly.";

function _isLikelyNetworkError(e){
  if(!e) return false;
  const name = e.name || '';
  const msg = (e.message || '').toLowerCase();
  if(name === 'TypeError' && msg.includes('fetch')) return true; // "Failed to fetch" (Chrome/Safari)
  if(msg.includes('networkerror')) return true; // Firefox: "NetworkError when attempting to fetch resource"
  if(msg.includes('load failed')) return true; // Safari
  if(msg.includes('network request failed')) return true; // React Native / some WebViews
  if(name === 'AbortError' || msg.includes('aborted') || msg.includes('timeout')) return true;
  return false;
}

async function edgeCall(payload){
  try{
    if(!navigator.onLine) return {ok:false,message:EDGE_ERR_OFFLINE};
    await loadSupabaseSDK();
    const sb=getSb();
    if(!sb) return {ok:false,message:EDGE_ERR_SERVER};
    const fp={...payload,student_key:sKey(),student_name:sName(),student_emoji:getMyEmoji(),student_avatar_url:getMyAvatarUrl()};
    let data, error;
    try{
      const res = await sb.functions.invoke('af-nexus-community-v2',{body:fp});
      data = res.data; error = res.error;
    }catch(invokeErr){
      // Transport-level throw (e.g. fetch itself rejected) rather than a
      // structured {error} response from the SDK.
      if(!navigator.onLine) return {ok:false,message:EDGE_ERR_OFFLINE};
      if(_isLikelyNetworkError(invokeErr)) return {ok:false,message:EDGE_ERR_NETWORK};
      return {ok:false,message:EDGE_ERR_SERVER};
    }
    if(error){
      // `error` here is the Supabase Functions client's error object. Its
      // `.message` is implementation detail (status codes, "non-2xx",
      // FunctionsHttpError/FunctionsFetchError class names, etc.) and is
      // never shown to the user — only our own classified copy is.
      if(_isLikelyNetworkError(error)) return {ok:false,message:EDGE_ERR_NETWORK};
      return {ok:false,message:EDGE_ERR_SERVER};
    }
    if(!data) return {ok:false,message:EDGE_ERR_SERVER};
    // `data` is our own backend's JSON payload. If it reports failure, its
    // `message` field is content we wrote ourselves (e.g. validation
    // errors), so it's safe and appropriate to surface directly.
    if(data.ok === false && !data.message){
      return {ok:false,message:EDGE_ERR_SERVER};
    }
    return data;
  }catch(e){
    if(!navigator.onLine) return {ok:false,message:EDGE_ERR_OFFLINE};
    if(_isLikelyNetworkError(e)) return {ok:false,message:EDGE_ERR_NETWORK};
    return {ok:false,message:EDGE_ERR_SERVER};
  }
}

/* ═══════════════════════════════════════════════════
   AVATAR HTML — gold vs standard verified
═══════════════════════════════════════════════════ */
function avatarHTML(name, emoji, avatarUrl, extraClass='', onClick='', isVer=false){
  const action = onClick ? ` onclick="${onClick}"` : '';
  // Gold frame for verified users (premium identity)
  const verClass = isVer ? ' gold-avatar-frame' : '';
  if(avatarUrl){
    return `<div class="avatar${extraClass}${verClass}"${action}><img src="${esc(avatarUrl)}" alt="${esc(name)}" loading="lazy" decoding="async" onerror="this.parentElement.innerHTML='${esc(initials(name))}'"/></div>`;
  }
  if(emoji){
    return `<div class="avatar${extraClass}${verClass}"${action}>${emoji}</div>`;
  }
  return `<div class="avatar initials${extraClass}${verClass}"${action}>${esc(initials(name))}</div>`;
}

/* verified badge HTML — gold badge for verified users */
function verBadgeHTML(isVer){
  if(!isVer) return '';
  return '<span class="gold-badge">★</span>';
}

/* ═══════════════════════════════════════════════════
   MY AVATAR BUTTON SYNC
═══════════════════════════════════════════════════ */
function syncAvatarBtn(){
  const btn=$('btnMyAvatar');
  if(!btn) return;
  const avatarUrl = getMyAvatarUrl();
  const emoji = getMyEmoji();
  const name = sName();
  if(avatarUrl){
    btn.innerHTML=`<img src="${esc(avatarUrl)}" alt="${esc(name)}" style="width:100%;height:100%;object-fit:cover;border-radius:50%;" onerror="this.parentElement.innerHTML='${esc(initials(name))}'"/>`;
    btn.style.background='transparent';
  } else if(emoji){
    btn.innerHTML=emoji;
    btn.style.background='var(--p)';
    btn.style.fontSize='18px';
  } else {
    btn.innerHTML=`<span style="font-size:12px;font-weight:800;">${esc(initials(name))}</span>`;
    btn.style.background='var(--p)';
  }
}

/* ═══════════════════════════════════════════════════
   TOAST
═══════════════════════════════════════════════════ */
function showToast(msg, type='ok', title=''){
  const w=$('toastWrap'); w.innerHTML='';
  const d=document.createElement('div');
  const isErr = type==='err';
  d.className = 'af-toast af-toast-' + (isErr ? 'err' : 'ok');
  d.setAttribute('role','alert');
  d.setAttribute('aria-live','assertive');
  const icon = isErr ? '⚠️' : '✓';
  d.innerHTML=`<span class="af-toast-ic">${icon}</span><div><p class="af-toast-title">${title||(isErr?'Error':'Done')}</p><p class="af-toast-msg">${esc(msg)}</p></div>`;
  w.appendChild(d);
  requestAnimationFrame(()=>d.classList.add('show'));
  setTimeout(()=>{d.classList.remove('show');setTimeout(()=>d.remove(),220);},2800);
}

function nxAddNotification(item){
  if(!item || !item.id) return;
  const next={...item, ts:item.ts||Date.now(), read:false};
  const idx=_cache.notifications.findIndex(n=>n.id===item.id);
  if(idx>=0) _cache.notifications[idx]={..._cache.notifications[idx],...next};
  else _cache.notifications.unshift(next);
  _cache.notifications=_cache.notifications.slice(0,50);
  nxRenderNotifications();
}

function nxScanFollowerNotifications(followers){
  if(!Array.isArray(followers)) return;
  followers.forEach(u=>{
    const key=String(u.student_key||u.key||'');
    if(!key || key===sKey() || _cache.notifiedFollowerKeys.has(key)) return;
    _cache.notifiedFollowerKeys.add(key);
    const name=u.student_name||u.name||'Someone';
    nxAddNotification({
      id:'follow:'+key,
      type:'follow',
      key,
      name,
      avatar_url:u.avatar_url||'',
      emoji:u.emoji||'',
      is_verified:!!u.is_verified,
      message:name+' followed you.'
    });
  });
}

function nxAddMessageNotification(peer, preview){
  if(!peer || !peer.student_key) return;
  const id='msg:'+peer.student_key+':'+(preview||'');
  if(_cache.notifiedMessageKeys.has(id)) return;
  _cache.notifiedMessageKeys.add(id);
  const name=peer.student_name||'Someone';
  nxAddNotification({
    id,
    type:'message',
    key:peer.student_key,
    name,
    avatar_url:peer.avatar_url||'',
    emoji:peer.emoji||'',
    is_verified:!!peer.is_verified,
    message:name+' messaged you.',
    preview
  });
}

function nxRenderNotifications(){
  const dot=$('feedNotifyDot');
  const unread=_cache.notifications.some(n=>!n.read);
  if(dot) dot.classList.toggle('hidden', !unread);
  const box=$('notificationList');
  if(!box) return;
  if(!_cache.notifications.length){
    box.innerHTML='<div class="notification-empty">No notifications yet.</div>';
    return;
  }
  box.innerHTML=_cache.notifications.map(n=>{
    const safeKey=esc(n.key||'');
    const safeName=esc(n.name||'Student').replace(/'/g,'&#39;');
    const action=n.type==='follow' && !_cache.followingKeys.has(String(n.key))
      ? `<button class="notification-action" onclick="nxNotificationFollowBack('${safeKey}','${safeName}',this)">Follow Back</button>`
      : (n.type==='message'
          ? `<button class="notification-action" onclick="nxOpenDM('${safeKey}','${safeName}');nxCloseNotifications();">Open</button>`
          : '');
    return `<div class="notification-row${n.read?'':' unread'}">
      ${avatarHTML(n.name,n.emoji||'',n.avatar_url||'',' avatar-sm','',!!n.is_verified)}
      <div class="notification-main">
        <strong>${esc(n.message)}</strong>
        ${n.preview?`<p>${esc(n.preview)}</p>`:`<p>${esc(timeAgo(n.ts))}</p>`}
      </div>
      ${action}
    </div>`;
  }).join('');
}

function nxOpenNotifications(){
  _cache.notifications=_cache.notifications.map(n=>({...n,read:true}));
  nxBringToFront('notificationsModal');
  $('notificationsModal').style.display='flex';
  nxRenderNotifications();
}
function nxCloseNotifications(){
  $('notificationsModal').style.display='none';
  nxRenderNotifications();
  nxForceRepaint();
}
async function nxNotificationFollowBack(key,name,btn){
  if(btn){btn.disabled=true;btn.textContent='...';}
  await nxSuggestedFollow(key,name,btn||{disabled:false,textContent:''});
  _cache.notifications=_cache.notifications.filter(n=>!(n.type==='follow'&&String(n.key)===String(key)));
  nxRenderNotifications();
  if(_activeTab==='chats') nxLoadChatsFromConnections();
}

/* ═══════════════════════════════════════════════════
   SEEN POST TRACKING (in-memory only)
═══════════════════════════════════════════════════ */
const _seenObserver = new IntersectionObserver((entries)=>{
  entries.forEach(entry=>{
    if(!entry.isIntersecting) return;
    const el = entry.target;
    const pid = el.dataset.postId;
    if(!pid) return;
    const existing = _cache.seenPostIds.get(pid);
    const startTs = existing?._visibleSince || Date.now();
    if(!existing || !existing._visibleSince){
      const rec = existing || {count:0,ts:Date.now(),duration:0};
      rec._visibleSince = startTs;
      _cache.seenPostIds.set(pid, rec);
      // After 2.5 seconds of visibility, mark as seen
      setTimeout(()=>{
        if(_cache.seenPostIds.get(pid)?._visibleSince === startTs){
          const r = _cache.seenPostIds.get(pid) || {count:0,ts:Date.now(),duration:0};
          r.count = (r.count||0) + 1;
          r.ts = Date.now();
          delete r._visibleSince;
          _cache.seenPostIds.set(pid, r);
        }
      }, 2500);
    }
  });
},{threshold:0.5});

function observePostCards(){
  document.querySelectorAll('.post-card[data-post-id]').forEach(el=>{
    _seenObserver.observe(el);
  });
}

function getSeenPenalty(pid){
  const r = _cache.seenPostIds.get(String(pid));
  if(!r || !r.count) return 1.0;
  if(r.count === 1) return 0.5;
  if(r.count === 2) return 0.2;
  return 0.05;
}

/* ═══════════════════════════════════════════════════
   SMART FEED RANKING ENGINE
   Score = 40% following + 25% interest + 15% freshness
           + 10% trending + 10% diversity
   With seen penalty and creator diversity cap
═══════════════════════════════════════════════════ */
function scorePost(p, followingKeys, recentCreators){
  const now = Date.now();
  const postAge = (now - new Date(p.created_at||now).getTime()) / 1000; // seconds

  // 40% — following priority
  const isFollowed = followingKeys.has(String(p.student_key||''));
  const followScore = isFollowed ? 1.0 : 0.2;

  // 25% — interest relevance (proxy: engagement ratio = likes / max(1, ageHours))
  const ageHours = Math.max(1, postAge / 3600);
  const engagementRate = ((p.likes_count||0) + (p.comments_count||0)*2) / ageHours;
  const interestScore = Math.min(1.0, engagementRate / 20);

  // 15% — freshness (exponential decay, half-life ~6h)
  const freshnessScore = Math.exp(-postAge / 21600);

  // 10% — trending (raw engagement absolute)
  const trendScore = Math.min(1.0, ((p.likes_count||0) + (p.comments_count||0)) / 50);

  // 10% — diversity (penalise if same creator appeared recently)
  const creatorRecentCount = recentCreators.filter(k=>k===String(p.student_key||'')).length;
  const diversityScore = creatorRecentCount >= 2 ? 0.0 : creatorRecentCount === 1 ? 0.4 : 1.0;

  // Verified boost (+10% flat additive)
  const verBoost = p.is_verified ? 0.10 : 0.0;

  const raw = (
    followScore    * 0.40 +
    interestScore  * 0.25 +
    freshnessScore * 0.15 +
    trendScore     * 0.10 +
    diversityScore * 0.10 +
    verBoost
  );

  // Apply seen penalty
  return raw * getSeenPenalty(p.id);
}

function rankFeed(posts, followingKeys){
  // Build a sliding window of recent creators for diversity
  const scored = posts.map((p, idx)=>({p, idx, rawScore: scorePost(p, followingKeys, [])}));
  scored.sort((a,b)=>b.rawScore - a.rawScore);

  // Now re-rank with creator diversity enforcement:
  // max 1 post from same creator within every 5-7 slots
  const result = [];
  const remaining = [...scored];
  const recentCreators = []; // last 6 creator keys in result

  while(remaining.length > 0){
    // find best eligible post (creator not in last 2 slots, or nothing else available)
    let chosenIdx = -1;
    for(let i=0;i<remaining.length;i++){
      const ck = String(remaining[i].p.student_key||'');
      const recentWindow = recentCreators.slice(-5);
      const countInWindow = recentWindow.filter(k=>k===ck).length;
      if(countInWindow < 1){ chosenIdx=i; break; }
    }
    if(chosenIdx === -1) chosenIdx = 0; // fallback: take best regardless
    const chosen = remaining.splice(chosenIdx,1)[0];
    result.push(chosen.p);
    recentCreators.push(String(chosen.p.student_key||''));
    if(recentCreators.length>12) recentCreators.shift();
  }

  return result;
}

function mergeFeedOnRefresh(existingPosts, freshPosts, followingKeys){
  const existingIds = new Set(existingPosts.map(p=>String(p.id)));
  const freshIds    = new Set(freshPosts.map(p=>String(p.id)));

  const newPosts    = freshPosts.filter(p=>!existingIds.has(String(p.id)));
  const updatedMap  = new Map(freshPosts.map(p=>[String(p.id),p]));

  const allPosts = [
    ...newPosts,
    ...existingPosts.map(p=>updatedMap.get(String(p.id))||p)
  ];

  const filtered = allPosts.filter(p=>freshIds.has(String(p.id))||existingIds.has(String(p.id)));
  return rankFeed(filtered, followingKeys);
}

/* ═══════════════════════════════════════════════════
   POST CARD RENDER
═══════════════════════════════════════════════════ */
let _activeTab='feed';
let _mode='relevant';
let _curPostId=null, _replyParentId=null, _menuTarget=null;
let _profileData=null, _profileIsFollowing=false;
let _dmPeer=null, _dmEditingId=null, _dmPendingImage=null;
let _emojiPickerMsgId=null;
const _RX_EMOJIS=['❤️','👍','😂','😮','😢','🔥'];
const _RX_RE=/^\[rx:([^:]+):(.+)\]$/;
const _DM_REPLY_RE=/^\u21A9\[(\d+)\] ([^\n]{0,80})\n([\s\S]*)$/;
let _myTypingTimer=null;     // debounce: stop broadcasting after idle
let _myTypingSendTimer=null; // throttle: don't spam set_typing on every keystroke
let _peerTypingTimer=null;   // auto-expire peer's typing indicator
let _dmSearchMatches=[];     // NodeList of matching bubble-wrap elements
let _dmSearchIdx=-1;         // currently focused match index
let _dmReplyTo=null;         // {id,text} — message being replied to
let _dmOldestTs=null;        // oldest message ts loaded (for pagination)
let _dmLoadingOlder=false;   // guard against concurrent pagination fetches
let _dmPeerReadAt=null;      // server-reported timestamp when peer last read this thread

/* ── Escape text then wrap search-term hits in <mark> ── */
function _hlText(raw, term){
  const escaped=esc(raw);
  if(!term) return escaped;
  // Escape special regex chars in the (already HTML-escaped) term
  const safeTerm=esc(term).replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  return escaped.replace(new RegExp('('+safeTerm+')','gi'),'<mark class="dm-hl">$1</mark>');
}

function nxOpenDMSearch(){
  show('dmSearchBar');
  $('dmSearchInput').value='';
  $('dmSearchCount').textContent='';
  $('dmSearchPrev').disabled=true;
  $('dmSearchNext').disabled=true;
  _dmSearchMatches=[]; _dmSearchIdx=-1;
  setTimeout(()=>$('dmSearchInput').focus(),80);
}
function nxCloseDMSearch(){
  hide('dmSearchBar');
  $('dmSearchInput').value='';
  _dmSearchMatches=[]; _dmSearchIdx=-1;
  // Re-render without highlights
  const chatObj=_cache.chatList.find(c=>c.peer.student_key===(_dmPeer&&_dmPeer.key));
  if(chatObj) nxRenderDMMessages(chatObj.messages,'');
}
function nxDMSearchInput(){
  const term=($('dmSearchInput').value||'').trim();
  const chatObj=_cache.chatList.find(c=>c.peer.student_key===(_dmPeer&&_dmPeer.key));
  if(!chatObj) return;
  nxRenderDMMessages(chatObj.messages, term);
  // Collect all highlighted rows
  _dmSearchMatches=Array.from($('dmMessages').querySelectorAll('.dm-search-match'));
  _dmSearchIdx=_dmSearchMatches.length>0?0:-1;
  _nxDMSearchUpdateUI();
  if(_dmSearchIdx>=0) _nxDMSearchFocus(_dmSearchIdx);
}
function nxDMSearchNav(dir){
  if(!_dmSearchMatches.length) return;
  _dmSearchIdx=(_dmSearchIdx+dir+_dmSearchMatches.length)%_dmSearchMatches.length;
  _nxDMSearchUpdateUI();
  _nxDMSearchFocus(_dmSearchIdx);
}
function _nxDMSearchFocus(idx){
  // Remove previous current highlight
  _dmSearchMatches.forEach(el=>el.classList.remove('dm-search-current'));
  const el=_dmSearchMatches[idx];
  if(!el) return;
  el.classList.add('dm-search-current');
  el.scrollIntoView({behavior:'smooth',block:'center'});
}
function _nxDMSearchUpdateUI(){
  const total=_dmSearchMatches.length;
  const countEl=$('dmSearchCount');
  const term=($('dmSearchInput').value||'').trim();
  if(!term){ countEl.textContent=''; $('dmSearchPrev').disabled=true; $('dmSearchNext').disabled=true; return; }
  countEl.textContent=total?`${_dmSearchIdx+1}/${total}`:'0 found';
  $('dmSearchPrev').disabled=total<2;
  $('dmSearchNext').disabled=total<2;
}

function nxSendTypingSignal(){
  if(!_dmPeer) return;
  // Throttle: only actually call the API once per 2s
  if(!_myTypingSendTimer){
    edgeCall({action:'set_typing',peer_key:_dmPeer.key}).catch(()=>{});
    _myTypingSendTimer=setTimeout(()=>{ _myTypingSendTimer=null; },2000);
  }
  // Stop signal after 3s of no further keystrokes
  clearTimeout(_myTypingTimer);
  _myTypingTimer=setTimeout(()=>{ _myTypingTimer=null; },3000);
}
function nxStopTypingSignal(){
  clearTimeout(_myTypingTimer); _myTypingTimer=null;
  clearTimeout(_myTypingSendTimer); _myTypingSendTimer=null;
}
function nxShowPeerTyping(){
  const el=$('dmHdrStatus');
  if(!el) return;
  el.innerHTML='<span class="typing-indicator"><span class="typing-dot"></span><span class="typing-dot"></span><span class="typing-dot"></span>&nbsp;typing…</span>';
  clearTimeout(_peerTypingTimer);
  _peerTypingTimer=setTimeout(nxClearPeerTyping,4000);
}
function nxClearPeerTyping(){
  clearTimeout(_peerTypingTimer); _peerTypingTimer=null;
  // Restore the status line — cheaply refresh it from cached presence
  const statusEl=$('dmHdrStatus');
  if(!statusEl||!_dmPeer) return;
  const pres=_cache.presence[_dmPeer.key];
  const presInfo=pres?formatPresence(pres):null;
  if(presInfo&&presInfo.online){
    statusEl.innerHTML='<span class="presence-online" style="font-size:12px;">Active now</span>';
    statusEl.style.color='';
  } else if(presInfo){
    statusEl.textContent=presInfo.label;
    statusEl.style.color='var(--tm)';
  } else {
    statusEl.textContent='Community Member';
    statusEl.style.color='var(--tm)';
  }
}

function nxShowEmojiPicker(e, msgId){
  e.stopPropagation();
  _emojiPickerMsgId=msgId;
  const picker=$('emojiPickerFloat');
  picker.style.display='flex';
  // Wait one frame so offsetWidth is accurate
  requestAnimationFrame(()=>{
    const pw=picker.offsetWidth||290, ph=picker.offsetHeight||52;
    const cx=(e.clientX!==undefined)?e.clientX:(e.pageX||window.innerWidth/2);
    const cy=(e.clientY!==undefined)?e.clientY:(e.pageY||window.innerHeight/2);
    let top=cy-ph-12;
    let left=Math.max(8,Math.min(cx-pw/2, window.innerWidth-pw-8));
    if(top<8) top=cy+16;
    picker.style.top=top+'px';
    picker.style.left=left+'px';
  });
}
function nxHideEmojiPicker(){
  $('emojiPickerFloat').style.display='none';
  _emojiPickerMsgId=null;
}
async function nxSendReaction(emoji){
  const msgId=_emojiPickerMsgId;
  nxHideEmojiPicker();
  if(!msgId||!_dmPeer) return;

  // ── Optimistic render: inject chip immediately so user sees it at once ──
  const targetBubble=document.querySelector(`[data-msg-id="${msgId}"]`);
  if(targetBubble){
    const col=targetBubble.parentElement; // the flex-column wrapper
    let rxRow=col.querySelector('.bubble-reactions');
    if(!rxRow){
      rxRow=document.createElement('div');
      rxRow.className='bubble-reactions';
      // Insert after the .bubble div, before .bubble-meta
      const meta=col.querySelector('.bubble-meta');
      if(meta) col.insertBefore(rxRow,meta);
      else col.appendChild(rxRow);
    }
    // Check if a chip for this emoji already exists
    const existing=[...rxRow.querySelectorAll('.reaction-chip')].find(c=>c.dataset.rxEmoji===emoji);
    if(existing){
      let cnt=existing.querySelector('.rx-count');
      if(cnt){ cnt.textContent=parseInt(cnt.textContent||'1')+1; }
      else { existing.insertAdjacentHTML('beforeend',` <span class="rx-count">2</span>`); }
      existing.classList.add('mine');
    } else {
      const chip=document.createElement('span');
      chip.className='reaction-chip mine';
      chip.dataset.rxEmoji=emoji;
      chip.textContent=emoji;
      rxRow.appendChild(chip);
    }
  }

  await edgeCall({action:'send_dm',to_key:_dmPeer.key,to_name:_dmPeer.name,text:`[rx:${msgId}:${emoji}]`});
  if(_dmPeer) nxRefreshPeerChat(_dmPeer.key);
}
// Build reaction map: msgId -> Map<emoji -> {count,mine}>
function _buildRxMap(msgs){
  const rxMap=new Map();
  const me=sKey();
  msgs.forEach(m=>{
    if(m.is_deleted||!m.text) return;
    const match=m.text.match(_RX_RE);
    if(!match) return;
    const[,targetId,emoji]=match;
    if(!rxMap.has(targetId)) rxMap.set(targetId,new Map());
    const em=rxMap.get(targetId);
    const entry=em.get(emoji)||{count:0,mine:false};
    entry.count++;
    if(m.sender===me) entry.mine=true;
    em.set(emoji,entry);
  });
  return rxMap;
}
function _renderRxChips(msgId, rxMap){
  const em=rxMap.get(String(msgId));
  if(!em||!em.size) return '';
  let html='';
  for(const[emoji,{count,mine}] of em)
    html+=`<span class="reaction-chip${mine?' mine':''}">${emoji}${count>1?` <span class="rx-count">${count}</span>`:''}</span>`;
  return `<div class="bubble-reactions">${html}</div>`;
}
// Attach gesture events on dmMessages box — runs once per app lifetime (idempotent)
// Gestures supported:
//   Swipe right on a bubble → Reply (works on both sent & received)
//   Double-tap a bubble     → Emoji reaction picker
//   Desktop dblclick        → Emoji reaction picker
function nxInitDMReactionEvents(){
  const box=$('dmMessages');
  if(!box||box._rxEventsInited) return;
  box._rxEventsInited=true;

  // ── Desktop: dblclick → emoji picker ──────────────────────────────
  box.addEventListener('dblclick',e=>{
    const b=e.target.closest('[data-msg-id]');
    if(b) nxShowEmojiPicker(e,b.dataset.msgId);
  });

  // ── Touch state ───────────────────────────────────────────────────
  let _lt=0, _lbid=null;            // double-tap tracking
  let _srStartX=0, _srStartY=0;     // swipe start coords
  let _srBubble=null;               // bubble element being swiped
  let _srBubbleInner=null;          // the .bubble div to translate
  let _srSwiping=false;             // true once horizontal intent confirmed

  function _snapBack(){
    if(!_srBubbleInner) return;
    _srBubbleInner.style.transition='transform .22s cubic-bezier(.25,.8,.25,1)';
    _srBubbleInner.style.transform='translateX(0)';
    setTimeout(()=>{ if(_srBubbleInner) _srBubbleInner.style.transition=''; }, 240);
  }

  box.addEventListener('touchstart',e=>{
    const touch=e.touches[0];
    _srStartX=touch.clientX;
    _srStartY=touch.clientY;
    _srSwiping=false;
    // Find the bubble elements
    _srBubble=e.target.closest('[data-msg-id]');
    _srBubbleInner=_srBubble||null;  // the element we'll translate IS the .bubble div
  },{passive:true});

  box.addEventListener('touchmove',e=>{
    const touch=e.touches[0];
    const dx=touch.clientX-_srStartX;
    const dy=Math.abs(touch.clientY-_srStartY);
    const adx=Math.abs(dx);

    // Confirm horizontal swipe intent once we've moved >12px and it's more horizontal than vertical
    if(!_srSwiping && adx>12 && adx>dy*1.4 && _srBubble){
      _srSwiping=true;
    }
    if(_srSwiping && _srBubbleInner){
      // Add swiping class to bubble-wrap for the reply hint arrow
      const wrap=_srBubbleInner.closest('.bubble-wrap');
      if(wrap) wrap.classList.add('swiping');
      // Allow swipe in BOTH directions, cap at 70px, add rubber-band feel past 55px
      let clamp=dx;
      if(adx>55) clamp=(dx>0?1:-1)*(55+(adx-55)*0.3);
      clamp=Math.max(-70,Math.min(70,clamp));
      _srBubbleInner.style.transition='none';
      _srBubbleInner.style.transform=`translateX(${clamp}px)`;
    }
  },{passive:true});

  box.addEventListener('touchend',e=>{
    const endX=e.changedTouches[0].clientX;
    const rawDx=endX-_srStartX;
    const adx=Math.abs(rawDx);

    // Always remove swiping class from bubble-wrap
    if(_srBubbleInner){
      const wrap=_srBubbleInner.closest('.bubble-wrap');
      if(wrap) wrap.classList.remove('swiping');
    }

    if(_srSwiping){
      _snapBack();
      // Trigger reply if swiped far enough (either direction)
      if(adx>50 && _srBubble && _srBubble.dataset.msgId){
        nxStartDMReply(_srBubble.dataset.msgId, _srBubble.dataset.msgText||'');
      }
      _srSwiping=false;
      _srBubble=null; _srBubbleInner=null;
      return; // don't fall through to double-tap check
    }
    _srBubble=null; _srBubbleInner=null;

    // ── Double-tap → emoji picker ──────────────────────────────────
    const b=e.target.closest('[data-msg-id]');
    if(!b) return;
    const bid=b.dataset.msgId, now=Date.now();
    if(bid===_lbid && now-_lt<320){
      e.preventDefault();
      const t=e.changedTouches[0];
      nxShowEmojiPicker({clientX:t.clientX,clientY:t.clientY,stopPropagation:()=>{}},bid);
      _lt=0; _lbid=null;
    } else { _lt=now; _lbid=bid; }
  },{passive:false});

  // Scroll to top → load older messages
  box.addEventListener('scroll',()=>{
    if(box.scrollTop===0 && !_dmLoadingOlder && _dmOldestTs && _dmPeer){
      nxLoadOlderDMs();
    }
  },{passive:true});
}

/* Show a small floating context menu above a bubble (reply + react) */
function nxShowBubbleContextMenu(bubbleEl, cx, cy){
  if(!bubbleEl) return;
  const msgId=bubbleEl.dataset.msgId;
  const msgText=bubbleEl.dataset.msgText||'';
  let menu=$('bubbleCtxMenu');
  if(!menu){
    menu=document.createElement('div');
    menu.id='bubbleCtxMenu';
    menu.style.cssText='position:fixed;z-index:9800;background:var(--card-s);border:1px solid var(--b1);border-radius:12px;box-shadow:var(--sh);display:flex;gap:0;overflow:hidden;font-size:13px;font-weight:700;';
    document.body.appendChild(menu);
    document.addEventListener('click',()=>{menu.style.display='none';},{capture:true,once:false});
  }
  menu.innerHTML=`
    <button onclick="nxStartDMReply('${msgId}',decodeURIComponent('${encodeURIComponent(msgText)}'));document.getElementById('bubbleCtxMenu').style.display='none';" style="padding:10px 16px;background:none;border:none;color:var(--t1);cursor:pointer;border-right:1px solid var(--b1);">↩ Reply</button>
    <button onclick="nxShowEmojiPicker({clientX:${cx||100},clientY:${cy||100},stopPropagation:()=>{}},${msgId});document.getElementById('bubbleCtxMenu').style.display='none';" style="padding:10px 16px;background:none;border:none;color:var(--t1);cursor:pointer;">☺ React</button>
  `;
  menu.style.display='flex';
  const vw=window.innerWidth, vh=window.innerHeight;
  const mw=180;
  let left=(cx||vw/2)-mw/2;
  let top=(cy||vh/2)-52;
  left=Math.max(8,Math.min(left,vw-mw-8));
  top=Math.max(8,Math.min(top,vh-60));
  menu.style.left=left+'px';
  menu.style.top=top+'px';
}

/* Safe wrapper: reads text from the bubble's data-msg-text attribute to avoid JS escaping issues */
function nxReplyFromBubbleBtn(btn){
  const bubble=btn.closest('[data-msg-id]');
  if(!bubble) return;
  nxStartDMReply(bubble.dataset.msgId, bubble.dataset.msgText||'');
}

/* DM reply-to */
function nxStartDMReply(msgId, text){
  _dmReplyTo={id:msgId, text};
  const preview=(text||'').slice(0,80);
  $('dmReplyPreview').textContent=preview||'message';
  show('dmReplyBanner');
  hide('dmEditBanner');
  _dmEditingId=null;
  const inp=$('dmInput');
  if(inp) inp.focus();
}
function nxCancelDMReply(){
  _dmReplyTo=null;
  hide('dmReplyBanner');
}

/* Load older DM messages (pagination — swipe-up) */
async function nxLoadOlderDMs(){
  if(_dmLoadingOlder||!_dmPeer||!_dmOldestTs) return;
  _dmLoadingOlder=true;
  const box=$('dmMessages');
  const loader=document.createElement('div');
  loader.className='dm-load-older-btn';
  loader.textContent='Loading older messages…';
  box.prepend(loader);
  const prevScrollHeight=box.scrollHeight;

  const res=await edgeCall({action:'fetch_dms',peer_key:_dmPeer.key,before_ts:_dmOldestTs});
  loader.remove();
  _dmLoadingOlder=false;

  if(!res||!res.ok) return;
  const allOlder=(res.messages||[]).filter(m=>new Date(m.ts).getTime()<new Date(_dmOldestTs).getTime());
  if(!allOlder.length) return; // nothing older

  const chatObj=_cache.chatList.find(c=>c.peer.student_key===_dmPeer.key);
  if(!chatObj) return;
  const existingIds=new Set(chatObj.messages.map(m=>String(m.id)));
  const newOlder=allOlder.filter(m=>!existingIds.has(String(m.id)));
  if(!newOlder.length) return;

  chatObj.messages=[...newOlder,...chatObj.messages];
  const scrollDiff=box.scrollHeight-box.scrollTop;
  nxRenderDMMessages(chatObj.messages);
  // Restore scroll so user stays at the same spot
  requestAnimationFrame(()=>{ box.scrollTop=box.scrollHeight-scrollDiff; });
}
let _reportPostId=null, _reportReason=null;
let _pendingAvatarDataUrl=null;
let _pendingPostImageDataUrl=null;

// ── FOLLOW-BACK SUGGESTIONS PAGINATION ─────────────────────
// Reveals suggestions progressively: 5 shown initially, then each
// "Show more" tap reveals 5 more (→10), then doubles each time after
// that (→20, →40, …) until every pending follower has been shown.
let _suggestedVisibleCount=5;
let _suggestedNextIncrement=5;
let _followListType='';       // 'followers' or 'following' — set when the modal opens
let _followListIsOwn=false;   // true when viewing your own list (shows action buttons)

