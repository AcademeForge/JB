// ── STORIES STATE ──────────────────────────────────────────
let _storyGroups=[];          // [{student_key, student_name, stories:[...], ...}]
let _chatsLoaded=false;       // true after the first real chat-list fetch completes
let _svGroupIdx=0;            // which group is open
let _svStoryIdx=0;            // which story within the group
let _svRenderToken=0;         // bumped on every render to invalidate stale async video loads
let _svTimer=null;            // auto-advance timer
let _svProgressInterval=null; // progress bar interval
let _storyPendingMedia=null;  // {dataUrl, mediaType}
let _svPaused=false;          // paused while seen-by panel is open
let _svReplyPaused=false;     // paused while reply input is focused
let _svHoldTimer=null;        // finger-hold timer
let _svHoldActive=false;      // true while finger is held down
let _svTouchStartY=0;         // touchstart Y for swipe-up detection
let _svTouchStartX=0;         // touchstart X

/* ═══════════════════════════════════════════════════
   PRESENCE HELPERS
═══════════════════════════════════════════════════ */
function formatPresence(pres){
  if(!pres) return null;
  if(pres.is_online) return {label:'Active now', online:true};
  if(!pres.last_seen_at) return null;
  const diff=Date.now()-new Date(pres.last_seen_at).getTime();
  const mins=Math.round(diff/60000);
  const hrs=Math.floor(diff/3600000);
  const days=Math.floor(diff/86400000);
  let label;
  if(mins<2)            label='Active just now';
  else if(mins<60)      label='Last seen '+mins+'m ago';
  else if(hrs<24){
    const d=new Date(pres.last_seen_at);
    let h=d.getHours(), m=d.getMinutes();
    const ap=h>=12?'PM':'AM'; h=h%12||12;
    label='Last seen at '+h+':'+String(m).padStart(2,'0')+' '+ap;
  } else if(days===1)   label='Last seen yesterday';
  else if(days<7){
    const dnames=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    label='Last seen '+dnames[new Date(pres.last_seen_at).getDay()];
  } else                label='Last seen a week ago';
  return {label, online:false};
}

async function nxFetchPresenceForChats(){
  const keys=_cache.chatList.map(c=>c.peer&&c.peer.student_key).filter(Boolean);
  if(!keys.length) return;
  const res=await edgeCall({action:'get_presence',keys});
  if(res&&res.ok&&res.presence){
    Object.assign(_cache.presence, res.presence);
    nxRenderChatList();
    // Re-render stories bar so online dots appear/disappear as presence updates
    nxRenderStoriesBar();
  }
}

/* ═══════════════════════════════════════════════════
   STORIES
═══════════════════════════════════════════════════ */
const STORY_IMG_DURATION = 15000;            // ms each image story stays on screen
const STORY_VIDEO_FALLBACK_DURATION = 8000;  // ms, used until a video's real duration loads
const STORY_IMG_MAX_BYTES = 2 * 1024 * 1024;  // 2 MB hard limit for image stories
const STORY_VID_MAX_BYTES = 3 * 1024 * 1024;  // 3 MB hard limit for video stories (after trim)
const STORY_VID_MAX_SECS  = 15;               // auto-trim videos longer than 15 s

/* ── Story video local cache ──
   Once a story video has been watched, it's cached on-device so re-opening
   the same story never re-downloads it. (Using IndexedDB rather than
   localStorage — localStorage is a small ~5MB synchronous text store and
   isn't safe for video binary data; IndexedDB is the correct on-device
   storage for this and gives the exact "no re-download on re-view" result.) */
const STORY_VID_DB_NAME='nx_story_video_cache';
const STORY_VID_STORE='videos';
const STORY_VID_CACHE_MAX_BYTES = 8*1024*1024;  // skip caching unusually large files
const STORY_VID_CACHE_MAX_ENTRIES = 30;         // evict oldest once cache grows past this
let _storyVidDbPromise=null;
function nxStoryVidDB(){
  if(_storyVidDbPromise) return _storyVidDbPromise;
  _storyVidDbPromise=new Promise(resolve=>{
    let settled=false;
    const finish=v=>{ if(!settled){ settled=true; resolve(v); } };
    try{
      const req=indexedDB.open(STORY_VID_DB_NAME,1);
      req.onupgradeneeded=()=>{
        try{
          const store=req.result.createObjectStore(STORY_VID_STORE);
          store.createIndex('by_t','t',{unique:false});
        }catch(e){}
      };
      req.onsuccess=()=>finish(req.result);
      req.onerror=()=>finish(null);
      // If another tab is mid-upgrade this can stall indefinitely — don't
      // let that ever block story playback.
      req.onblocked=()=>finish(null);
      // Safety net: cache is a nice-to-have, story playback is not allowed
      // to wait on it forever.
      setTimeout(()=>finish(null), 2500);
    }catch(e){ finish(null); }
  });
  return _storyVidDbPromise;
}
async function nxGetCachedStoryVideo(url){
  try{
    const db=await nxStoryVidDB();
    if(!db) return null;
    const rec=await new Promise(res=>{
      try{
        const tx=db.transaction(STORY_VID_STORE,'readonly');
        const req=tx.objectStore(STORY_VID_STORE).get(url);
        req.onsuccess=()=>res(req.result||null);
        req.onerror=()=>res(null);
        tx.onerror=()=>{}; // already resolved above; just prevent an uncaught tx error
      }catch(e){ res(null); }
    });
    return (rec && rec.blob) ? rec.blob : null;
  }catch(e){ return null; }
}
function nxStoryVidPutOnce(db,url,blob){
  return new Promise((resolve,reject)=>{
    try{
      const tx=db.transaction(STORY_VID_STORE,'readwrite');
      tx.oncomplete=()=>resolve(true);
      tx.onerror=()=>reject(tx.error);
      tx.onabort=()=>reject(tx.error);
      tx.objectStore(STORY_VID_STORE).put({blob,t:Date.now()},url);
    }catch(e){ reject(e); }
  });
}
function nxEvictOldStoryVideos(db,keepCount){
  return new Promise(resolve=>{
    try{
      const tx=db.transaction(STORY_VID_STORE,'readwrite');
      const store=tx.objectStore(STORY_VID_STORE);
      const countReq=store.count();
      countReq.onsuccess=()=>{
        const toDelete=(countReq.result||0)-keepCount;
        if(toDelete<=0){ resolve(); return; }
        let deleted=0;
        const cursorReq=store.index('by_t').openCursor(); // oldest first
        cursorReq.onsuccess=e=>{
          const cursor=e.target.result;
          if(!cursor || deleted>=toDelete){ resolve(); return; }
          cursor.delete();
          deleted++;
          cursor.continue();
        };
        cursorReq.onerror=()=>resolve();
      };
      countReq.onerror=()=>resolve();
      tx.onerror=()=>resolve();
      tx.onabort=()=>resolve();
    }catch(e){ resolve(); }
  });
}
async function nxPutCachedStoryVideo(url,blob){
  try{
    const db=await nxStoryVidDB();
    if(!db) return;
    try{
      await nxStoryVidPutOnce(db,url,blob);
    }catch(e){
      // Most likely QuotaExceededError — drop the oldest cached videos and
      // retry once rather than failing silently forever.
      try{
        await nxEvictOldStoryVideos(db,0);
        await nxStoryVidPutOnce(db,url,blob);
      }catch(e2){ return; } // give up quietly; video already played fine from network
    }
    nxEvictOldStoryVideos(db,STORY_VID_CACHE_MAX_ENTRIES).catch(()=>{});
  }catch(e){}
}
// De-dupe concurrent fetch+cache attempts for the same video (e.g. fast
// prev/next swiping back onto the same uncached story before it finishes).
const _storyVidFetchInFlight=new Map();
// Pre-resolved blob URLs: populated by background prefetch so nxShowCurrentStory
// can start playback synchronously (zero IDB lookup delay) when the user taps.
// Each entry is consumed (deleted) on first use so the video element owns the
// object URL and nxClearStoryMediaEl can safely revoke it.
const _preResolvedBlobUrls=new Map();
function nxFetchAndCacheStoryVideo(url){
  if(_storyVidFetchInFlight.has(url)) return _storyVidFetchInFlight.get(url);
  const p=fetch(url).then(r=>r.ok?r.blob():null).then(async blob=>{
    if(blob && blob.size>0 && blob.size<=STORY_VID_CACHE_MAX_BYTES){
      await nxPutCachedStoryVideo(url,blob);
      // Create a blob URL immediately and stash it in memory so the next
      // nxShowCurrentStory call for this URL can assign src synchronously —
      // no IDB read, no network wait, instant first frame.
      if(!_preResolvedBlobUrls.has(url)){
        try{ _preResolvedBlobUrls.set(url, URL.createObjectURL(blob)); }catch(e){}
      }
    }
  }).catch(()=>{}).finally(()=>{ _storyVidFetchInFlight.delete(url); });
  _storyVidFetchInFlight.set(url,p);
  return p;
}
// Resolves the src to actually assign to the <video> element:
// - instant local blob: URL if this video was already cached
// - otherwise the original network URL, while quietly fetching + caching it
//   in the background so the NEXT view is served from cache.
async function nxResolveStoryVideoSrc(url){
  if(!url) return url;
  const cached=await nxGetCachedStoryVideo(url);
  if(cached){
    try{ return URL.createObjectURL(cached); }catch(e){ return url; }
  }
  nxFetchAndCacheStoryVideo(url);
  return url;
}

/* ── INSTAGRAM-STYLE STORY PREFETCHING ──────────────────────
   Two prefetch moments, same as Instagram:
   1. The instant the stories bar loads, warm the first 5 stories'
      media in the background — before the user has even tapped a ring —
      so opening any of them feels instant.
   2. The instant a story is actually being viewed, quietly warm the
      *next* story's media too, so swiping forward never shows a spinner. */
const _storyImagePreloadCache=new Set(); // url -> already requested this session
function nxPreloadStoryMedia(url, mediaType){
  if(!url) return;
  if(mediaType==='video'){
    // Reuses the existing IndexedDB blob cache + in-flight de-dupe —
    // exactly the same path nxResolveStoryVideoSrc uses when actually
    // playing a video, just triggered earlier.
    nxFetchAndCacheStoryVideo(url);
  } else {
    if(_storyImagePreloadCache.has(url)) return;
    _storyImagePreloadCache.add(url);
    // Warms the browser's own HTTP cache for the image so the <img> the
    // viewer creates later paints from cache instead of the network.
    const img=new Image();
    img.decoding='async';
    img.src=url;
  }
}
function nxPreloadInitialStories(){
  // ── Tiered Instagram-style warm-up ──────────────────────────────────
  // Tier 1 (groups 0-1): preload EVERY story — these are the first rings
  //   the user sees and most likely to tap straight through.
  // Tier 2 (groups 2-4): preload only the first story per group — a quick
  //   head-start so opening any of these feels instant too.
  _storyGroups.slice(0,2).forEach(g=>{
    (g.stories||[]).forEach(s=>{ if(s) nxPreloadStoryMedia(s.media_url, s.media_type); });
  });
  _storyGroups.slice(2,5).forEach(g=>{
    const first = g.stories && g.stories[0];
    if(first) nxPreloadStoryMedia(first.media_url, first.media_type);
  });
}
function nxPrefetchNextStoryMedia(grp, storyIdx){
  // While viewing story N, warm stories N+1 AND N+2 so two taps forward
  // are always already cached. Also warm the previous story for backwards
  // swipes — Instagram does the same.
  const stories=grp.stories||[];
  const nextGrp=_storyGroups[_svGroupIdx+1];
  const prevGrp=_storyGroups[_svGroupIdx-1];

  // N+1 and N+2 (spill into next group when at the end of this one)
  for(let offset=1; offset<=2; offset++){
    let s=stories[storyIdx+offset];
    if(!s && nextGrp){
      const spill=(storyIdx+offset)-stories.length;
      s=(nextGrp.stories||[])[spill>=0?spill:0];
    }
    if(s) nxPreloadStoryMedia(s.media_url, s.media_type);
  }

  // N-1 (previous story or last story of previous group)
  const prevStory=stories[storyIdx-1]||
    (prevGrp&&(prevGrp.stories||[]).slice(-1)[0]);
  if(prevStory) nxPreloadStoryMedia(prevStory.media_url, prevStory.media_type);
}
// Revokes any blob: video src currently in #svMedia, then clears the slide.
// Centralized here so every place that clears story media also releases
// the previous cached-video blob: URL instead of leaking it.
function nxClearStoryMediaEl(){
  const media=$('svMedia');
  if(!media) return;
  media.querySelectorAll('video').forEach(v=>{
    if(v.src && v.src.startsWith('blob:')){ try{ URL.revokeObjectURL(v.src); }catch(e){} }
  });
  media.querySelectorAll('img,video').forEach(n=>n.remove());
}

async function nxLoadStories(){
  // Paint skeleton rings immediately before the network call
  const scroll=$('storiesScroll');
  if(scroll && !_storyGroups.length){
    const skelItem=`<div class="story-skel-item story-item story-other">
      <div class="af-skel story-skel-ring"></div>
      <div class="af-skel story-skel-label"></div>
    </div>`;
    // Remove any existing skeleton items, then inject 5 placeholders
    scroll.querySelectorAll('.story-skel-item').forEach(el=>el.remove());
    scroll.insertAdjacentHTML('beforeend', skelItem.repeat(5));
  }
  const res=await edgeCall({action:'fetch_stories'});
  if(!res||!res.ok){
    // Remove skeleton items even on failure
    scroll&&scroll.querySelectorAll('.story-skel-item').forEach(el=>el.remove());
    return;
  }
  _storyGroups = Array.isArray(res.groups)?res.groups:[];
  nxRenderStoriesBar();
  nxPreloadInitialStories(); // warm the first 5 stories' media before any tap (Instagram-style)
}

function syncMyStoryAvatar(){
  nxRenderStoriesBar();
}

function nxRenderStoriesBar(){
  const scroll=$('storiesScroll');
  if(!scroll) return;

  // "Your Story" avatar + ring — the "+" button itself is left untouched
  const inner=$('myStoryAvatarInner');
  if(inner){
    const avatarUrl=getMyAvatarUrl(), emoji=getMyEmoji(), name=sName();
    if(avatarUrl){
      inner.innerHTML=`<img src="${esc(avatarUrl)}" alt="${esc(name)}" loading="lazy" decoding="async" onerror="this.style.display='none'"/>`;
    } else if(emoji){
      inner.textContent=emoji;
    } else {
      inner.textContent=initials(name);
    }
  }
  const mine = _storyGroups.find(g=>g.is_mine);
  const ring=$('yourStoryRing');
  const plusBtn=$('yourStoryPlus');
  if(ring){
    const hasMine = !!(mine && mine.stories && mine.stories.length);
    ring.classList.toggle('mine-ring', hasMine);
    ring.classList.toggle('story-ring-add', !hasMine);
    // Always show "+" so the user can replace their story
    if(plusBtn) plusBtn.style.display = '';
  }

  // Other users' story rings, appended after the static "Your Story" item
  scroll.querySelectorAll('.story-item.story-other').forEach(el=>el.remove());
  const others = _storyGroups.filter(g=>!g.is_mine);
  const html = others.map(g=>renderStoryItemHtml(g, _storyGroups.indexOf(g))).join('');
  if(html) scroll.insertAdjacentHTML('beforeend', html);
}

function renderStoryItemHtml(g, idx){
  const seen = !g.has_unviewed;
  const seenClass = seen ? ' seen' : '';
  const avatarInner = g.avatar_url
    ? `<img src="${esc(g.avatar_url)}" alt="${esc(g.student_name||'')}" loading="lazy" decoding="async" onerror="this.style.display='none'"/>`
    : esc(g.emoji || initials(g.student_name));
  const label = g.username ? ('@'+esc(g.username)) : esc((g.student_name||'Student').split(/\s+/)[0]);
  const premTick = g.is_verified ? `<span class="story-ver-tick">✦</span>` : '';
  // Show green dot if this contact is currently online
  const presData = g.student_key ? _cache.presence[g.student_key] : null;
  const presInfo = presData ? formatPresence(presData) : null;
  const onlineDot = (presInfo && presInfo.online) ? '<div class="story-online-dot"></div>' : '';
  return `<div class="story-item story-other${seen?' story-seen':''}" onclick="nxOpenStoryViewer(${idx})">
    <div class="story-ring${seenClass}" style="position:relative;">
      <div class="story-avatar-wrap">${avatarInner}</div>
      ${onlineDot}
    </div>
    <span class="story-label">${label}${premTick}</span>
  </div>`;
}

function nxYourStoryClick(){
  const mine=_storyGroups.find(g=>g.is_mine);
  if(mine && mine.stories && mine.stories.length){
    // Has a story → open the viewer
    const idx=_storyGroups.indexOf(mine);
    nxOpenStoryViewer(idx);
  } else {
    // No story → open composer
    nxOpenStoryComposer();
  }
}

/* ── STORY VIEWER ──────────────────────────────────── */
function nxOpenStoryViewer(groupIdx){
  if(!_storyGroups.length || groupIdx<0 || groupIdx>=_storyGroups.length) return;
  _svGroupIdx=groupIdx;
  _svPaused=false;
  const grp=_storyGroups[groupIdx];
  const firstUnviewed = grp.stories.findIndex(s=>!s.is_viewed);
  _svStoryIdx = firstUnviewed>=0 ? firstUnviewed : 0;
  nxBringToFront('storyViewer');
  $('storyViewer').classList.add('open');
  nxRenderStoryProgressBars();
  nxShowCurrentStory();
}

let _storyBarDirty = false;
function nxCloseStoryViewer(){
  nxCloseSeenBy();
  const cu=$('svCaughtUp'); if(cu) cu.classList.remove('active');
  clearTimeout(_svTimer); clearInterval(_svProgressInterval);
  _svTimer=null; _svProgressInterval=null; _svPaused=false;
  const el=$('storyViewer');
  if(el) el.classList.remove('open');
  const media=$('svMedia');
  if(media){
    const v=media.querySelector('video');
    if(v){ try{ v.pause(); }catch(e){} }
  }
  nxClearStoryMediaEl();
  if(_storyBarDirty){ nxRenderStoriesBar(); _storyBarDirty=false; }
  _seenCountCache.clear();
  nxForceRepaint();
}

function nxRenderStoryProgressBars(){
  const grp=_storyGroups[_svGroupIdx];
  const wrap=$('svProgress');
  if(!wrap||!grp) return;
  wrap.innerHTML = grp.stories.map((_,i)=>`<div class="sv-prog-seg"><div class="sv-prog-seg-fill" id="svSeg-${i}"></div></div>`).join('');
}

function nxGoToGroup(newGroupIdx, enterFrom){
  if(newGroupIdx<0){ nxCloseStoryViewer(); return; }
  if(newGroupIdx>=_storyGroups.length){ nxShowCaughtUp(); return; }
  _svGroupIdx=newGroupIdx;
  const grp=_storyGroups[newGroupIdx];
  _svStoryIdx = enterFrom==='end' ? grp.stories.length-1 : 0;
  nxRenderStoryProgressBars();
  nxShowCurrentStory();
}
function nxShowCaughtUp(){
  clearTimeout(_svTimer); clearInterval(_svProgressInterval);
  nxCloseSeenBy();
  const media=$('svMedia');
  if(media){ const v=media.querySelector('video'); if(v) try{v.pause();}catch(e){} }
  const cu=$('svCaughtUp'); if(cu) cu.classList.add('active');
}

/* Format a date/time for "seen at" display — e.g. "Today 3:42 PM", "Mon 9 Jun, 10:05 AM" */
function storySeenAt(isoStr){
  if(!isoStr) return '';
  try{
    const d=new Date(isoStr);
    const now=new Date();
    const isToday=d.toDateString()===now.toDateString();
    const yesterday=new Date(now); yesterday.setDate(now.getDate()-1);
    const isYesterday=d.toDateString()===yesterday.toDateString();
    let h=d.getHours(), m=d.getMinutes();
    const ampm=h>=12?'PM':'AM'; h=h%12||12;
    const mm=String(m).padStart(2,'0');
    const time=h+':'+mm+' '+ampm;
    if(isToday) return 'Today '+time;
    if(isYesterday) return 'Yesterday '+time;
    const days=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    const months=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return days[d.getDay()]+' '+d.getDate()+' '+months[d.getMonth()]+', '+time;
  }catch(e){ return ''; }
}

function nxShowCurrentStory(){
  clearTimeout(_svTimer); clearInterval(_svProgressInterval);
  nxCloseSeenBy();
  const cu=$('svCaughtUp'); if(cu) cu.classList.remove('active');
  const grp=_storyGroups[_svGroupIdx];
  if(!grp){ nxCloseStoryViewer(); return; }
  if(_svStoryIdx<0){ nxGoToGroup(_svGroupIdx-1, 'end'); return; }
  if(_svStoryIdx>=grp.stories.length){ nxGoToGroup(_svGroupIdx+1, 'start'); return; }

  const story=grp.stories[_svStoryIdx];
  const _renderToken = (++_svRenderToken);

  // Header
  const av=$('svHdrAv');
  if(av){
    av.innerHTML = grp.avatar_url
      ? `<img src="${esc(grp.avatar_url)}" alt="${esc(grp.student_name||'')}" onerror="this.style.display='none'"/>`
      : esc(grp.emoji || initials(grp.student_name));
  }
  // Header: gold gradient name for verified users + premium badge
  const nameEl=$('svHdrName');
  if(grp.is_mine){
    nameEl.innerHTML=`<span>Your Story</span>`;
    nameEl.style.cssText='';
  } else if(grp.is_verified){
    nameEl.innerHTML=`<span style="color:#f59e0b;font-weight:800;">${esc(grp.student_name||'Student')}</span>${verBadgeHTML(true)}`;
    nameEl.style.cssText='';
  } else {
    nameEl.textContent=grp.student_name||'Student';
    nameEl.style.cssText='';
  }
  // Make header avatar+name clickable for other users' stories
  const svHdrClickable=$('svHdrClickable');
  if(svHdrClickable){
    if(!grp.is_mine && grp.student_key){
      svHdrClickable.classList.add('sv-tappable');
      svHdrClickable.onclick=()=>{
        nxCloseStoryViewer();
        nxOpenProfile(grp.student_key, grp.student_name||'Student');
      };
    } else {
      svHdrClickable.classList.remove('sv-tappable');
      svHdrClickable.onclick=null;
    }
  }
  $('svHdrTime').textContent = storySeenAt(story.created_at);
  const captionEl=$('svCaption');
  if(captionEl){
    const cap = story.caption||'';
    captionEl.textContent = cap;
    captionEl.classList.toggle('has-text', cap.length > 0);
  }

  // 3-dot options button: only for own stories
  const optsBtn=$('svOptsBtn');
  if(optsBtn) optsBtn.style.display = grp.is_mine ? 'flex' : 'none';
  nxCloseStoryOpts();

  // Bottom bar: only visible for own stories
  const bar=$('svBottomBar');
  const seenBtn=$('svSeenBtn');
  if(bar){
    if(grp.is_mine){
      bar.classList.add('visible');
      // Seen count will be loaded async
      if(seenBtn) $('svSeenCount').textContent='…';
      nxLoadSeenCount(story.id);
    } else {
      bar.classList.remove('visible');
    }
  }

  // Swipe-up hint lives inside sv-bottom-bar — no separate toggle needed

  // Reply bar: shown for others' stories
  const replyBar=$('svReplyBar');
  if(replyBar){
    if(!grp.is_mine){
      replyBar.classList.add('visible');
      const inp=$('svReplyInput');
      if(inp) inp.value='';
      const btn=$('svReplySendBtn');
      if(btn) btn.disabled=true;
    } else {
      replyBar.classList.remove('visible');
    }
  }

  // Reset progress segments
  grp.stories.forEach((_,i)=>{
    const seg=$('svSeg-'+i);
    if(!seg) return;
    if(i<_svStoryIdx){ seg.classList.add('done'); seg.style.transition='none'; seg.style.width='100%'; }
    else if(i>_svStoryIdx){ seg.classList.remove('done'); seg.style.transition='none'; seg.style.width='0%'; }
  });
  const curSeg=$('svSeg-'+_svStoryIdx);
  if(curSeg){ curSeg.classList.remove('done'); curSeg.style.transition='none'; curSeg.style.width='0%'; }

  // Media
  const mediaWrap=$('svMedia');
  nxClearStoryMediaEl();
  let mediaEl;
  if(story.media_type==='video'){
    mediaEl=document.createElement('video');
    mediaEl.playsInline=true;
    mediaEl.preload='auto';
    mediaEl.muted=false;
    mediaEl.onended=()=>nxStoryNext();
    mediaEl.onloadedmetadata=()=>{
      // Start accurate progress now that we know the real duration
      nxRunStoryProgress((mediaEl.duration||8)*1000);
    };
    mediaWrap.appendChild(mediaEl);

    // ── FAST PATH: prefetch already resolved a blob URL into memory ──
    // Blob URL is synchronous — assign src immediately, play with no delay
    // and no flash. Delete from map so nxClearStoryMediaEl owns the URL.
    const preResolved=_preResolvedBlobUrls.get(story.media_url);
    if(preResolved){
      _preResolvedBlobUrls.delete(story.media_url);
      mediaEl.style.opacity='1';
      mediaEl.src=preResolved;
      mediaEl.load();
      const pp=mediaEl.play();
      if(pp) pp.catch(()=>{ nxRunStoryProgress(STORY_VIDEO_FALLBACK_DURATION); });
    } else {
      // ── STREAMING PATH: set network URL synchronously — browser starts
      // buffering immediately, first frame appears as soon as bandwidth allows.
      // This is strictly faster than the old approach of waiting for an async
      // IDB lookup before setting the src at all.
      mediaEl.style.opacity='0';
      mediaEl.style.transition='opacity .12s linear';
      const revealOnReady=()=>{ mediaEl.style.opacity='1'; };
      mediaEl.addEventListener('loadeddata', revealOnReady, {once:true});
      mediaEl.addEventListener('canplay', revealOnReady, {once:true});
      mediaEl.addEventListener('error', ()=>{ mediaEl.style.opacity='1'; }, {once:true});
      // Fallback: unhide after 2s even if events never fire
      setTimeout(()=>{ if(mediaEl.style.opacity==='0') mediaEl.style.opacity='1'; }, 2000);
      mediaEl.src=story.media_url;
      mediaEl.load();
      const pp=mediaEl.play();
      if(pp) pp.catch(()=>{ revealOnReady(); nxRunStoryProgress(STORY_VIDEO_FALLBACK_DURATION); });
      // Fetch + cache in background — next view of this story will hit the fast path
      nxFetchAndCacheStoryVideo(story.media_url);
    }
  } else {
    mediaEl=document.createElement('img');
    mediaEl.src=story.media_url;
    mediaEl.alt='Story';
    nxRunStoryProgress(STORY_IMG_DURATION);
    mediaWrap.appendChild(mediaEl);
  }

  // Mark viewed (once per story)
  if(!story.is_viewed){
    story.is_viewed=true;
    grp.has_unviewed = grp.stories.some(s=>!s.is_viewed);
    edgeCall({action:'view_story',story_id:story.id}).catch(()=>{});
    _storyBarDirty=true;
  }

  // Instagram-style read-ahead: warm the next story's media now, while
  // this one is on screen, so advancing never shows a loading state.
  nxPrefetchNextStoryMedia(grp, _svStoryIdx);
}

const _seenCountCache = new Map();
async function nxLoadSeenCount(storyId){
  if(_seenCountCache.has(storyId)){
    const el=$('svSeenCount');
    if(el) el.textContent=_seenCountCache.get(storyId);
    return;
  }
  const res=await edgeCall({action:'get_story_views',story_id:storyId});
  const count = (res&&res.ok&&Array.isArray(res.views)) ? res.views.length : 0;
  _seenCountCache.set(storyId,count);
  const el=$('svSeenCount');
  if(el) el.textContent=count;
}

/* ── SEEN-BY PANEL ── */
async function nxOpenSeenBy(){
  const grp=_storyGroups[_svGroupIdx];
  if(!grp||!grp.is_mine) return;
  const story=grp.stories[_svStoryIdx];
  if(!story) return;

  // Pause the story while panel is open
  _svPaused=true;
  clearTimeout(_svTimer); clearInterval(_svProgressInterval);

  const panel=$('svSeenPanel');
  const list=$('svSeenList');
  if(panel) panel.classList.add('open');
  if(list) list.innerHTML='<div class="state-msg" style="color:var(--t2);">Loading…</div>';

  const res=await edgeCall({action:'get_story_views',story_id:story.id});
  if(!res||!res.ok){
    if(list) list.innerHTML='<div class="state-msg" style="color:var(--t2);">Could not load.</div>';
    return;
  }
  const views=Array.isArray(res.views)?res.views:[];
  // Update count
  const el=$('svSeenCount'); if(el) el.textContent=views.length;

  if(!views.length){
    if(list) list.innerHTML='<div class="state-msg" style="color:var(--t2);"><span>👁</span><span>No views yet.</span></div>';
    return;
  }

  if(list) list.innerHTML=views.map(v=>{
    const name=v.username?('@'+esc(v.username)):esc(v.student_name||'Student');
    const when=storySeenAt(v.viewed_at);
    const av=avatarHTML(v.student_name||'Student',v.emoji||'',v.avatar_url||'',' avatar-sm',`nxCloseSeenBy();nxOpenProfile('${esc(v.viewer_key)}','${esc(v.student_name||'Student').replace(/'/g,"&#39;")}')`,!!v.is_verified);
    return `<div class="sv-seen-row">
      ${av}
      <div class="sv-seen-info">
        <div class="sv-seen-name">${name}</div>
        ${when?`<div class="sv-seen-when">${esc(when)}</div>`:''}
      </div>
    </div>`;
  }).join('');
}

function nxCloseSeenBy(){
  const panel=$('svSeenPanel');
  if(panel) panel.classList.remove('open');
  // Resume story only if viewer is still open
  if(_svPaused && $('storyViewer').classList.contains('open')){
    _svPaused=false;
    // Re-run the progress from current position (restart the current story)
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
  }
  _svPaused=false;
}

/* ── Story 3-dot options menu ── */
function nxOpenStoryOpts(){
  _svPaused=true; clearTimeout(_svTimer); clearInterval(_svProgressInterval);
  const vid=$('svMedia').querySelector('video'); if(vid) vid.pause();
  const menu=$('svOptsMenu'); if(menu) menu.classList.add('open');
}
function nxCloseStoryOpts(){
  const menu=$('svOptsMenu'); if(menu) menu.classList.remove('open');
}

/* ── Story touch: hold-to-pause + swipe-up for viewers ── */
function nxSvTouchStart(e){
  const tgt=e.target;
  if(tgt.tagName==='INPUT'||tgt.tagName==='BUTTON') return;
  _svTouchStartY=e.touches[0].clientY;
  _svTouchStartX=e.touches[0].clientX;
  _svHoldActive=false;
  clearTimeout(_svHoldTimer);
  _svHoldTimer=setTimeout(()=>{
    _svHoldActive=true;
    if(!_svPaused && !_svReplyPaused){
      _svPaused=true;
      clearTimeout(_svTimer); clearInterval(_svProgressInterval);
      const vid=$('svMedia').querySelector('video'); if(vid) vid.pause();
    }
  }, 180);
}
function nxSvTouchEnd(e){
  clearTimeout(_svHoldTimer);
  if(_svHoldActive){
    _svHoldActive=false;
    if(_svPaused && !_svReplyPaused){
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
    }
    return; // hold-release, no swipe processing
  }
  // Seen panel open: no story swipes
  const panel=$('svSeenPanel');
  if(panel && panel.classList.contains('open')) return;
  // Horizontal swipe → change story (left=next, right=prev)
  const dx=e.changedTouches[0].clientX-_svTouchStartX;
  const dy=Math.abs(e.changedTouches[0].clientY-_svTouchStartY);
  if(Math.abs(dx)>60 && dy<80 && Math.abs(dx)>dy){
    if(dx<0) nxStoryNext(); // swipe left → next
    else nxStoryPrev();     // swipe right → prev
  }
}
function nxSvTouchMove(e){
  if(e.target.tagName==='INPUT') return;
  const dy=_svTouchStartY-e.touches[0].clientY;
  const dx=Math.abs(e.touches[0].clientX-_svTouchStartX);

  // Seen panel open: swipe down closes it
  const panel=$('svSeenPanel');
  if(panel && panel.classList.contains('open')){
    const inner=panel.querySelector('.sv-seen-panel-inner');
    const atTop=!inner || inner.scrollTop<=4;
    if(atTop && dy < -70 && dx<55){
      clearTimeout(_svHoldTimer); _svHoldActive=false;
      e.preventDefault();
      nxCloseSeenBy();
    }
    return; // don't process other gestures while panel is open
  }

  if(dx>30){ clearTimeout(_svHoldTimer); _svHoldActive=false; return; }
  // Swipe up on own story → open seen-by
  const grp=_storyGroups[_svGroupIdx];
  if(grp&&grp.is_mine && dy>65 && dx<45){
    clearTimeout(_svHoldTimer); _svHoldActive=false;
    e.preventDefault();
    nxOpenSeenBy();
  }
}

/* ── Story reply / reaction helpers ── */
function nxSvPauseForReply(){
  if(!_svPaused){ _svPaused=true; _svReplyPaused=true; clearTimeout(_svTimer); clearInterval(_svProgressInterval); }
}
function nxSvResumeFromReply(){
  if(!_svReplyPaused) return;
  const inp=$('svReplyInput');
  if(inp&&inp.value.trim()) return;
  _svReplyPaused=false;
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
}
function nxStoryReplyTyping(){
  const inp=$('svReplyInput');
  const btn=$('svReplySendBtn');
  if(btn) btn.disabled=!(inp&&inp.value.trim());
}
async function nxStorySendReaction(emoji){
  const grp=_storyGroups[_svGroupIdx];
  if(!grp||grp.is_mine) return;
  const peerKey=grp.student_key; if(!peerKey) return;
  const res=await edgeCall({action:'send_dm', to_key:peerKey, to_name:grp.student_name||'Student', text:emoji});
  if(res&&res.ok){
    const rb=$('svReplyBar');
    if(rb){
      const fb=document.createElement('div');
      fb.textContent=emoji;
      fb.style.cssText='position:absolute;bottom:80px;left:50%;transform:translateX(-50%);font-size:44px;opacity:1;transition:opacity .6s,transform .6s;pointer-events:none;z-index:10;';
      rb.appendChild(fb);
      requestAnimationFrame(()=>{ fb.style.opacity='0'; fb.style.transform='translateX(-50%) translateY(-40px) scale(1.4)'; });
      setTimeout(()=>fb.remove(), 700);
    }
    nxSvResumeFromReply();
  }
}
async function nxStorySendReply(){
  const grp=_storyGroups[_svGroupIdx];
  if(!grp||grp.is_mine) return;
  const inp=$('svReplyInput');
  const text=inp&&inp.value.trim(); if(!text) return;
  const peerKey=grp.student_key;
  if(!peerKey){ showToast('Cannot identify story owner.','warn'); return; }
  const btn=$('svReplySendBtn');
  if(btn) btn.disabled=true;
  // Prefix message so recipient sees story context in DM thread
  const fullText='\u21A9 Replied to your story:\n'+text;
  const res=await edgeCall({action:'send_dm', to_key:peerKey, to_name:grp.student_name||'Student', text:fullText});
  if(res&&res.ok){
    // Also update the local chat cache so the reply appears instantly in chats tab
    if(res.message){
      nxAppendSentMessage(peerKey, res.message);
    }
    if(inp){ inp.value=''; }
    if(btn) btn.disabled=true; // stays disabled until user types again
    inp&&inp.blur();
    nxSvResumeFromReply();
    showToast('Message sent!');
  } else {
    if(btn) btn.disabled=false;
    showToast(res?.message||'Failed to send. Try again.','warn');
  }
}

let _svProgressStart=0;
function nxRunStoryProgress(durationMs){
  clearInterval(_svProgressInterval); clearTimeout(_svTimer);
  const seg=$('svSeg-'+_svStoryIdx);
  if(seg){ seg.style.transition='none'; seg.style.width='0%'; }
  _svProgressStart=Date.now();
  _svProgressInterval=setInterval(()=>{
    if(_svPaused) return;
    const pct=Math.min(100, ((Date.now()-_svProgressStart)/durationMs)*100);
    if(seg) seg.style.width=pct+'%';
    if(pct>=100){
      clearInterval(_svProgressInterval);
      if(seg) seg.classList.add('done');
      nxStoryNext();
    }
  },50);
  // Safety-net timer in case the interval is ever throttled/dropped
  _svTimer=setTimeout(()=>{ if(!_svPaused) nxStoryNext(); }, durationMs+150);
}

function nxStoryNext(){
  clearTimeout(_svTimer); clearInterval(_svProgressInterval);
  _svStoryIdx++;
  nxShowCurrentStory();
}
function nxStoryPrev(){
  clearTimeout(_svTimer); clearInterval(_svProgressInterval);
  _svStoryIdx--;
  nxShowCurrentStory();
}

async function nxDeleteCurrentStory(){
  const grp=_storyGroups[_svGroupIdx];
  if(!grp||!grp.is_mine) return;
  const story=grp.stories[_svStoryIdx];
  if(!story) return;
  const res=await edgeCall({action:'delete_story',story_id:story.id});
  if(!res||!res.ok){ showToast(res?.message||'Could not delete story.','err'); return; }
  grp.stories.splice(_svStoryIdx,1);
  showToast('Story deleted.');
  nxCloseSeenBy();
  _storyBarDirty=true;
  if(!grp.stories.length){
    _storyGroups.splice(_svGroupIdx,1);
    nxCloseStoryViewer();
  } else {
    if(_svStoryIdx>=grp.stories.length) _svStoryIdx=grp.stories.length-1;
    nxRenderStoryProgressBars();
    nxShowCurrentStory();
  }
}

/* ── STORY COMPOSER ────────────────────────────────── */
function nxOpenStoryComposer(){
  if(!isLoggedIn()){ goToLogin(); return; }
  // FIX v64: only premium (is_verified) members can post stories
  if(!_cache.myVerified){
    showToast('Only Premium members can post stories. Premium is unlocked automatically based on your activity and contribution. Keep posting and engaging!', 'err');
    return;
  }
  // Allow re-posting — the edge function atomically replaces the existing story
  const mine=_storyGroups.find(g=>g.is_mine);
  if(mine && mine.stories && mine.stories.length){
    showToast('Posting a new story will replace your current one.','info');
  }
  _storyPendingMedia=null;
  if($('scImageInput')) $('scImageInput').value='';
  if($('scVideoInput')) $('scVideoInput').value='';
  if($('scCaption')) $('scCaption').value='';
  $('scPostBtn').disabled=true;
  nxRenderStoryComposerPreview();
  nxBringToFront('storyComposer');
  $('storyComposer').classList.add('open');
}
function nxCloseStoryComposer(){
  const el=$('storyComposer');
  if(el) el.classList.remove('open');
  _storyPendingMedia=null;
  nxForceRepaint();
}

function nxRenderStoryComposerPreview(){
  const preview=$('scPreview');
  if(!preview) return;
  if(!_storyPendingMedia){
    preview.innerHTML='<div class="sc-empty" id="scEmpty"><div class="sc-empty-icon">📷</div><p>Pick a photo or video below</p></div>';
    return;
  }
  if(_storyPendingMedia.mediaType==='video'){
    preview.innerHTML=`<video src="${_storyPendingMedia.dataUrl}" controls autoplay muted playsinline style="max-width:100%;max-height:100%;"></video>`;
  } else {
    preview.innerHTML=`<img src="${_storyPendingMedia.dataUrl}" alt="Story preview"/>`;
  }
}

function nxHandleStoryMedia(input, type){
  const file=input.files&&input.files[0];
  if(!file) return;

  if(type==='image'){
    if(file.size>STORY_IMG_MAX_BYTES){
      showToast('Image too large — please keep it under 2 MB.','err');
      input.value=''; return;
    }
    const reader=new FileReader();
    reader.onload=e=>{
      _storyPendingMedia={dataUrl:e.target.result, mediaType:'image'};
      nxRenderStoryComposerPreview();
      $('scPostBtn').disabled=false;
    };
    reader.onerror=()=>{ showToast('Could not read image.','err'); };
    reader.readAsDataURL(file);
    return;
  }

  // ── VIDEO path ──
  // Step 1: load into a hidden video element to read duration, then trim to 15 s
  $('scPostBtn').disabled=true;
  const objUrl=URL.createObjectURL(file);
  const vid=document.createElement('video');
  vid.muted=true; vid.playsInline=true; vid.preload='metadata';
  vid.src=objUrl;

  vid.onloadedmetadata=async ()=>{
    const rawDuration=isFinite(vid.duration)&&vid.duration>0 ? vid.duration : 0;
    const needsTrim = rawDuration > STORY_VID_MAX_SECS;

    const readBlob=blob=>new Promise((res,rej)=>{
      const r=new FileReader();
      r.onload=e=>res(e.target.result);
      r.onerror=rej;
      r.readAsDataURL(blob);
    });

    let dataUrl;
    if(!needsTrim){
      // Video is ≤15 s — just read original file
      try{ dataUrl=await readBlob(file); }
      catch(e){ showToast('Could not read video.','err'); URL.revokeObjectURL(objUrl); $('scPostBtn').disabled=false; input.value=''; return; }
    } else {
      // Trim to STORY_VID_MAX_SECS using captureStream + MediaRecorder
      showToast('Video is longer than 15 s — trimming…');
      try{
        const stream = vid.captureStream ? vid.captureStream() : (vid.mozCaptureStream ? vid.mozCaptureStream() : null);
        if(!stream) throw new Error('captureStream not supported');
        const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp8') ? 'video/webm;codecs=vp8' : 'video/webm';
        const chunks=[];
        const recorder=new MediaRecorder(stream,{mimeType});
        recorder.ondataavailable=e=>{ if(e.data&&e.data.size>0) chunks.push(e.data); };
        await new Promise((res,rej)=>{
          recorder.onstop=res;
          recorder.onerror=rej;
          recorder.start(100);
          vid.currentTime=0;
          vid.play().catch(()=>{});
          setTimeout(()=>{ try{ vid.pause(); recorder.stop(); }catch(e){rej(e);} }, STORY_VID_MAX_SECS*1000);
        });
        const trimmedBlob=new Blob(chunks,{type:mimeType});
        if(trimmedBlob.size>STORY_VID_MAX_BYTES){
          URL.revokeObjectURL(objUrl);
          showToast('Video file is too large even after trimming (max 3 MB). Please pick a shorter clip.','err');
          $('scPostBtn').disabled=false; input.value=''; return;
        }
        dataUrl=await readBlob(trimmedBlob);
      } catch(err){
        // captureStream/MediaRecorder unavailable — fall back to original file with size check
        if(file.size>STORY_VID_MAX_BYTES){
          URL.revokeObjectURL(objUrl);
          showToast('Video file too large (max 3 MB). Please choose a shorter clip.','err');
          $('scPostBtn').disabled=false; input.value=''; return;
        }
        try{ dataUrl=await readBlob(file); }
        catch(e){ showToast('Could not read video.','err'); URL.revokeObjectURL(objUrl); $('scPostBtn').disabled=false; input.value=''; return; }
      }
    }

    // Final size guard on the selected / trimmed data URL
    const approxBytes = Math.round((dataUrl.length - dataUrl.indexOf(',') - 1) * 3/4);
    if(approxBytes > STORY_VID_MAX_BYTES){
      URL.revokeObjectURL(objUrl);
      showToast('Video file too large (max 3 MB). Please choose a shorter clip.','err');
      $('scPostBtn').disabled=false; input.value=''; return;
    }

    URL.revokeObjectURL(objUrl);
    _storyPendingMedia={dataUrl, mediaType:'video'};
    nxRenderStoryComposerPreview();
    $('scPostBtn').disabled=false;
  };

  vid.onerror=()=>{
    URL.revokeObjectURL(objUrl);
    showToast('Could not load video file.','err');
    $('scPostBtn').disabled=false; input.value='';
  };
}

async function nxPostStory(){
  if(!_storyPendingMedia) return;
  $('scPostBtn').disabled=true;
  const uploadRes=await edgeCall({action:'upload_story_media',media_data_url:_storyPendingMedia.dataUrl});
  if(!uploadRes||!uploadRes.ok){
    showToast(uploadRes?.message||'Upload failed.','err');
    $('scPostBtn').disabled=false;
    return;
  }
  const caption=(($('scCaption')&&$('scCaption').value)||'').trim();
  const res=await edgeCall({
    action:'create_story',
    media_url:uploadRes.media_url,
    media_type:uploadRes.media_type,
    media_path:uploadRes.media_path||'',
    caption
  });
  if(!res||!res.ok){
    showToast(res?.message||'Could not post story.','err');
    $('scPostBtn').disabled=false;
    return;
  }
  nxCloseStoryComposer();
  showToast('Story shared!');
  nxLoadStories(); // fire-and-forget — composer is closed, no need to block on this
}

window.nxYourStoryClick=nxYourStoryClick;
window.nxOpenStoryViewer=nxOpenStoryViewer;
window.nxCloseStoryViewer=nxCloseStoryViewer;
window.nxStoryNext=nxStoryNext;
window.nxStoryPrev=nxStoryPrev;
window.nxDeleteCurrentStory=nxDeleteCurrentStory;
window.nxOpenStoryComposer=nxOpenStoryComposer;
window.nxCloseStoryComposer=nxCloseStoryComposer;
window.nxHandleStoryMedia=nxHandleStoryMedia;
window.nxPostStory=nxPostStory;
window.nxOpenSeenBy=nxOpenSeenBy;
window.nxCloseSeenBy=nxCloseSeenBy;
window.nxOpenStoryOpts=nxOpenStoryOpts;
window.nxCloseStoryOpts=nxCloseStoryOpts;
window.nxSvTouchStart=nxSvTouchStart;
window.nxSvTouchEnd=nxSvTouchEnd;
window.nxSvTouchMove=nxSvTouchMove;
window.nxStorySendReaction=nxStorySendReaction;
window.nxStoryReplyTyping=nxStoryReplyTyping;
window.nxStorySendReply=nxStorySendReply;
window.nxSvPauseForReply=nxSvPauseForReply;
window.nxSvResumeFromReply=nxSvResumeFromReply;

function renderPostHtml(p, mk, admin, showPinned){
  const mine=String(p.student_key||'')===String(mk||'');
  const peerEmoji=p.emoji||'';
  const peerAvatarUrl=p.avatar_url||'';
  const isVer=!!p.is_verified;
  const av=avatarHTML(p.student_name,peerEmoji,peerAvatarUrl,'',`nxOpenProfile('${esc(p.student_key)}','${esc(p.student_name).replace(/'/g,"&#39;")}')`,isVer);
  const pinBar=(showPinned&&p.is_pinned)?`<div class="pin-badge">📌 Pinned</div>`:'';
  const prev=esc((p.content||'').replace(/[\n\r]/g,' ').slice(0,55)).replace(/'/g,'&#39;');

  // Gold card for verified, standard card otherwise
  const cardClass = isVer ? ' gold-post-card' : (p.is_pinned?' pinned':'');
  const likedClass=_cache.likedPostIds.has(p.id)?' liked':'';

  // Name display: gold gradient text for verified
  const nameHtml = isVer
    ? `<span class="gold-name">${esc(p.student_name||'Student')}</span>${verBadgeHTML(true)}`
    : esc(p.student_name||'Student');

  // Posts longer than ~4 lines get clamped with a "Read More" toggle.
  const rawContent = p.content||'';
  const lineBreakCount = (rawContent.match(/\n/g)||[]).length;
  const isLong = lineBreakCount >= 4 || rawContent.length > 220;
  const postTextHtml = rawContent ? (isLong
    ? `<p class="post-text clamped" id="post-text-${p.id}">${esc(rawContent)}</p>
       <button class="read-more-btn" id="read-more-${p.id}" onclick="event.stopPropagation();nxToggleReadMore(${p.id})">Read More</button>`
    : `<p class="post-text" onclick="nxOpenComments(${p.id},'${prev}')" style="cursor:pointer;">${esc(rawContent)}</p>`)
    : '';

  // Post image — opacity starts at 0, fades in once loaded (no jarring pop-in)
  const imageHtml = p.image_url
    ? `<div class="post-image" onclick="nxOpenLightbox('${esc(p.image_url)}')"><img src="${esc(p.image_url)}" alt="Post image" loading="lazy" decoding="async" onload="this.style.opacity=1"/></div>`
    : '';

  return `<div class="post-card${cardClass}" data-post-id="${p.id}">
    ${pinBar}
    <div class="post-top">
      <div class="post-author">
        ${av}
        <div class="post-meta">
          <strong onclick="nxOpenProfile('${esc(p.student_key)}','${esc(p.student_name).replace(/'/g,"&#39;")}')" style="display:flex;align-items:center;gap:0;">
            ${nameHtml}
          </strong>
          <small onclick="nxOpenProfile('${esc(p.student_key)}','${esc(p.student_name).replace(/'/g,"&#39;")}')">${p.username?'@'+esc(p.username)+' · ':''}${esc(timeAgo(p.created_at))}</small>
        </div>
      </div>
      <button class="menu-dot" onclick="nxOpenMenu('post',${p.id},${mine},${!!p.is_pinned})">⋯</button>
    </div>
    ${postTextHtml}
    ${imageHtml}
    <div class="post-actions">
      <button class="action-btn${likedClass}" id="like-btn-${p.id}" onclick="nxLikePost(${p.id},this)">
        <span class="heart-ic" id="like-icon-${p.id}"><svg viewBox="0 0 24 24"><path d="M12 21s-7.5-4.8-10.2-9.6C.2 8.4 1.4 4.8 4.8 3.6c2.1-.7 4.3 0 5.6 1.7l1.6 2 1.6-2c1.3-1.7 3.5-2.4 5.6-1.7 3.4 1.2 4.6 4.8 3 7.8C19.5 16.2 12 21 12 21z"/></svg></span>
        <span class="cnt" id="like-cnt-${p.id}">${p.likes_count>0?p.likes_count:''}</span>
      </button>
      <button class="action-btn" onclick="nxOpenComments(${p.id},'${prev}')">💬 <span class="cnt" id="cmt-cnt-${p.id}">${p.comments_count||0}</span></button>
    </div>
  </div>`;
}

function nxToggleReadMore(pid){
  const textEl=$('post-text-'+pid);
  const btnEl=$('read-more-'+pid);
  if(!textEl||!btnEl) return;
  const isClamped=textEl.classList.contains('clamped');
  if(isClamped){
    textEl.classList.remove('clamped');
    textEl.style.marginBottom='6px';
    btnEl.textContent='Read Less';
  } else {
    textEl.classList.add('clamped');
    textEl.style.marginBottom='';
    btnEl.textContent='Read More';
  }
}
window.nxToggleReadMore=nxToggleReadMore;

function renderListToContainer(posts, containerId, checkPinned){
  const box=$(containerId); if(!box) return;
  if(!posts||!posts.length){
    box.innerHTML='<div class="state-msg"><span>✨</span><span>No posts to show.</span></div>';
    return;
  }
  const mk=sKey(), admin=isAdmin();
  let ordered=posts;
  if(checkPinned){
    const pinned=posts.filter(p=>p.is_pinned);
    const normal=posts.filter(p=>!p.is_pinned);
    ordered=[...pinned,...normal];
  }

  // Diff against currently rendered cards to avoid wiping the whole feed on every realtime INSERT.
  const existingCards=[...box.querySelectorAll(':scope > [data-post-id]')];
  const existingIds=existingCards.map(el=>el.getAttribute('data-post-id'));
  const incomingIds=ordered.map(p=>String(p.id));
  const existingSet=new Set(existingIds);
  const newOnes=ordered.filter(p=>!existingSet.has(String(p.id)));
  const changedRatio = existingIds.length ? (newOnes.length / Math.max(existingIds.length, incomingIds.length)) : 1;
  const isFirstPaint = existingCards.length===0;

  if(!isFirstPaint && changedRatio<=0.5){
    // Partial update: prepend only genuinely new cards, leave the rest of the DOM untouched.
    if(newOnes.length){
      const frag=document.createElement('div');
      frag.innerHTML=newOnes.map(p=>renderPostHtml(p,mk,admin,checkPinned)).join('');
      while(frag.firstChild){ box.insertBefore(frag.firstChild, box.firstChild); }
    }
    requestAnimationFrame(observePostCards);
    return;
  }

  box.innerHTML=ordered.map(p=>renderPostHtml(p,mk,admin,checkPinned)).join('');
  // Append feed-end marker if this is the main feed
  if(containerId==='postsList' && posts.length > 0){
    box.innerHTML += '<div class="feed-end-msg">🎉 Take a break. You\'re all caught up.</div>';
  }
  // Start observing for seen tracking
  requestAnimationFrame(observePostCards);
}

