/* ═══════════════════════════════════════════════════
   COMPOSER
═══════════════════════════════════════════════════ */
function nxOpenComposer(){
  if(!isLoggedIn()){goToLogin();return;}
  const inp=$('postInput');
  if(inp){inp.value='';nxPostTyping();setTimeout(()=>inp.focus(),10);}
  _pendingPostImageDataUrl=null;
  hide('postImagePreviewWrap');
  if($('postImageInput')) $('postImageInput').value='';
  nxApplyPostAttachGate();
  nxBringToFront('composerModal');
  $('composerModal').style.display='flex';
}
// Only Premium (verified) members can attach images to posts — mirrors the
// existing story-posting restriction.
function nxApplyPostAttachGate(){
  const btn=$('postAttachBtn');
  if(btn) btn.style.opacity=_cache.myVerified?'1':'.4';
}
function nxAttachPostImage(){
  if(!_cache.myVerified){
    showToast('Only Premium members can attach images to posts. Premium is unlocked automatically based on your activity and contribution. Keep posting and engaging!', 'err');
    return;
  }
  const input=$('postImageInput');
  if(input) input.click();
}
function nxCloseComposer(){
  $('composerModal').style.display='none';
  nxForceRepaint();
}
function nxPostTyping(){
  const v=$('postInput').value,w=wordCount(v),ex=w>80;
  $('postCount').textContent=w+' / 80 words';
  $('postCount').classList.toggle('warn',ex);
  $('postSubmitBtn').disabled=ex||(w===0&&!_pendingPostImageDataUrl);
  $('postInput').classList.toggle('over',ex);
}
function nxHandlePostImage(input){
  const file=input.files&&input.files[0];
  if(!file) return;
  if(!_cache.myVerified){
    // Defense in depth — in case this handler is ever reached without
    // going through the nxAttachPostImage() gate above.
    showToast('Only Premium members can attach images to posts. Premium is unlocked automatically based on your activity and contribution. Keep posting and engaging!', 'err');
    input.value='';
    return;
  }
  if(file.size>2*1024*1024){showToast('Image must be under 2MB.','err');return;}
  const reader=new FileReader();
  reader.onload=e=>{
    _pendingPostImageDataUrl=e.target.result;
    $('postImagePreview').src=_pendingPostImageDataUrl;
    show('postImagePreviewWrap');
    nxPostTyping();
  };
  reader.readAsDataURL(file);
}
function nxRemovePostImage(){
  _pendingPostImageDataUrl=null;
  if($('postImageInput')) $('postImageInput').value='';
  hide('postImagePreviewWrap');
  nxPostTyping();
}
async function nxCreatePost(){
  const inp=$('postInput'),content=inp.value.trim();
  if(wordCount(content)>80) return;
  if(!content&&!_pendingPostImageDataUrl) return;
  $('postSubmitBtn').disabled=true;

  let imageUrl='';
  if(_pendingPostImageDataUrl){
    const uploadRes=await edgeCall({action:'upload_post_image',image_data_url:_pendingPostImageDataUrl});
    if(uploadRes&&uploadRes.ok&&uploadRes.image_url){
      imageUrl=uploadRes.image_url;
    } else {
      showToast(uploadRes?.message||'Image upload failed.','err');
      $('postSubmitBtn').disabled=false;
      return;
    }
  }

  const payload={action:'create_post',content};
  if(imageUrl) payload.image_url=imageUrl;
  const res=await edgeCall(payload);
  if(!res||!res.ok){showToast(res?.message||'Could not post.','err');$('postSubmitBtn').disabled=false;return;}
  inp.value=''; nxRemovePostImage(); nxCloseComposer();
  showToast('Posted successfully!');
  // Optimistic prepend: immediately show the new post at top of feed
  // without waiting for the next refresh cycle.
  if(res.post){
    const newPost={
      ...res.post,
      student_name: sName(),
      emoji: getMyEmoji(),
      avatar_url: getMyAvatarUrl(),
      is_verified: _cache.myVerified,
      is_liked: false,
    };
    _cache.posts.unshift(newPost);
    const list=$('postsList');
    if(list){
      const tmp=document.createElement('div');
      tmp.innerHTML=renderPostHtml(newPost, sKey(), isAdmin(), false);
      const card=tmp.firstElementChild;
      if(card){
        list.insertBefore(card, list.firstChild);
        _seenObserver.observe(card);
      }
    }
  }
}

/* ═══════════════════════════════════════════════════
   LIKE (optimistic, prevents double count)
═══════════════════════════════════════════════════ */
const _likeInFlight = new Set();
async function nxLikePost(pid, btnEl){
  if(!sKey() || _likeInFlight.has(pid)) return;
  _likeInFlight.add(pid);
  const wasLiked = _cache.likedPostIds.has(pid);
  const cntEl = $('like-cnt-'+pid);
  const iconEl = $('like-icon-'+pid);

  // 1. Optimistic Update (UI)
  if(wasLiked){
    _cache.likedPostIds.delete(pid);
    const newCount = Math.max(0, (parseInt(cntEl?.textContent,10)||0) - 1);
    if(cntEl) cntEl.textContent = newCount>0 ? newCount : '';
    if(btnEl) btnEl.classList.remove('liked');
    const pIdx = _cache.posts.findIndex(p=>p.id===pid);
    if(pIdx>=0) _cache.posts[pIdx].likes_count = newCount;
  } else {
    _cache.likedPostIds.add(pid);
    const newCount = (parseInt(cntEl?.textContent,10)||0) + 1;
    if(cntEl) cntEl.textContent = newCount;
    if(btnEl) btnEl.classList.add('liked');
    // IG/FB-style pop animation only plays when liking, not unliking
    if(iconEl){
      iconEl.classList.remove('pop');
      void iconEl.offsetWidth; // restart animation
      iconEl.classList.add('pop');
    }
    const pIdx = _cache.posts.findIndex(p=>p.id===pid);
    if(pIdx>=0) _cache.posts[pIdx].likes_count = newCount;
  }

  // Persist locally so the red/liked state survives refresh & app reopen
  saveLikedPostIds();

  try{
    await edgeCall({action:'toggle_post_like',post_id:pid});
  } catch(e){
    // rollback: re-toggle the optimistic update
    const wasLikedNow = !_cache.likedPostIds.has(pid);
    if(wasLikedNow){ _cache.likedPostIds.delete(pid); btnEl&&btnEl.classList.remove('liked'); }
    else { _cache.likedPostIds.add(pid); btnEl&&btnEl.classList.add('liked'); }
    saveLikedPostIds();
  } finally {
    _likeInFlight.delete(pid);
  }
}

/* ═══════════════════════════════════════════════════
   COMMENTS (optimistic, prevents double count)
═══════════════════════════════════════════════════ */
function nxOpenComments(pid,preview){
  _curPostId=pid;
  const inp=$('commentInput');
  if(inp){inp.value='';nxCommentTyping();}
  $('commentsPreview').textContent=preview?preview+'…':'Join the discussion';
  nxBringToFront('commentsModal');
  $('commentsModal').style.display='flex';
  nxLoadComments(pid);
}
function nxCloseComments(){
  $('commentsModal').style.display='none';
  _curPostId=null;
  nxForceRepaint();
}
const _commentsCache = new Map();
async function nxLoadComments(pid){
  const box=$('commentsList'); if(!box) return;
  if(_commentsCache.has(pid)){
    renderComments(_commentsCache.get(pid));
  } else {
    box.innerHTML='<div class="state-msg">Loading…</div>';
  }
  const res=await edgeCall({action:'fetch_comments',post_id:pid});
  if(!res||!res.ok){
    if(!_commentsCache.has(pid)) box.innerHTML='<div class="state-msg"><span>Could not load.</span></div>';
    return;
  }
  const list=Array.isArray(res.comments)?res.comments:[];
  _commentsCache.set(pid,list);
  renderComments(list);
}
function renderComments(list){
  const box=$('commentsList'); if(!box) return;
  if(!list||!list.length){box.innerHTML='<div class="state-msg"><span>💬</span><span>No comments yet.</span></div>';return;}
  const byP={};
  list.forEach(c=>{const k=c.parent_comment_id?String(c.parent_comment_id):'root';if(!byP[k])byP[k]=[];byP[k].push(c);});

  // Verified comments float above regular (spec requirement)
  const root=byP.root||[];
  root.sort((a,b)=>{
    if(!!b.is_verified!==!!a.is_verified) return b.is_verified?1:-1;
    return 0;
  });

  const mk=sKey();
  box.innerHTML=root.map(c=>{
    const mine=String(c.student_key||'')===String(mk||'');
    const replies=byP[String(c.id)]||[];
    const prev=esc((c.content||'').slice(0,45)).replace(/'/g,'&#39;');
    const isVer=!!c.is_verified;
    const cAvatarUrl=c.avatar_url||'';
    const nameHtml = isVer
      ? `<span class="gold-name">${esc(c.student_name||'Student')}</span>${verBadgeHTML(true)}`
      : esc(c.student_name||'Student');
    return `<div class="cmt-card${isVer?' gold-post-card':''}">
      <div class="cmt-top">
        <div style="display:flex;align-items:center;gap:8px;flex:1;min-width:0;cursor:pointer;" onclick="nxOpenProfile('${esc(c.student_key)}','${esc(c.student_name).replace(/'/g,"&#39;")}')">
          ${avatarHTML(c.student_name,c.emoji||'',cAvatarUrl,' avatar-sm','',isVer)}
          <div class="cmt-info"><strong style="display:flex;align-items:center;gap:0;">${nameHtml}</strong><small>${esc(timeAgo(c.created_at))}</small></div>
        </div>
        <button class="menu-dot" style="width:24px;height:24px;font-size:13px;" onclick="nxOpenMenu('comment',${c.id},${mine},false)">⋯</button>
      </div>
      <p class="cmt-text">${esc(c.content||'')}</p>
      <div class="cmt-actions">
        <button class="cmt-btn${c.is_liked?' liked':''}" id="cmt-like-btn-${c.id}" onclick="nxLikeComment(${c.id},this)">
          <span class="heart-ic heart-ic-sm" id="cmt-like-icon-${c.id}"><svg viewBox="0 0 24 24"><path d="M12 21s-7.5-4.8-10.2-9.6C.2 8.4 1.4 4.8 4.8 3.6c2.1-.7 4.3 0 5.6 1.7l1.6 2 1.6-2c1.3-1.7 3.5-2.4 5.6-1.7 3.4 1.2 4.6 4.8 3 7.8C19.5 16.2 12 21 12 21z"/></svg></span>
          <span class="cnt" id="cmt-like-cnt-${c.id}">${c.likes_count>0?c.likes_count:''}</span>
        </button>
        <button class="cmt-btn" onclick="nxOpenReply(${c.id},'${prev}')">Reply</button>
      </div>
      ${replies.length?`
        <button class="view-replies-btn" onclick="nxToggleReplies(${c.id})">▸ ${replies.length} repl${replies.length===1?'y':'ies'}</button>
        <div id="rep-${c.id}" class="replies-wrap hidden">
          ${replies.map(r=>{
            const rm=String(r.student_key||'')===String(mk||'');
            const rp=esc((r.content||'').slice(0,45)).replace(/'/g,'&#39;');
            const rVer=!!r.is_verified;
            const rAvatarUrl=r.avatar_url||'';
            const rNameHtml = rVer
              ? `<span class="gold-name">${esc(r.student_name||'Student')}</span>${verBadgeHTML(true)}`
              : esc(r.student_name||'Student');
            return `<div>
              <div class="cmt-top">
                <div style="display:flex;align-items:center;gap:8px;flex:1;min-width:0;cursor:pointer;" onclick="nxOpenProfile('${esc(r.student_key)}','${esc(r.student_name).replace(/'/g,"&#39;")}')">
                  ${avatarHTML(r.student_name,r.emoji||'',rAvatarUrl,' avatar-sm','',rVer)}
                  <div class="cmt-info"><strong style="display:flex;align-items:center;gap:0;">${rNameHtml}</strong><small>${esc(timeAgo(r.created_at))}</small></div>
                </div>
                <button class="menu-dot" style="width:24px;height:24px;font-size:13px;" onclick="nxOpenMenu('comment',${r.id},${rm},false)">⋯</button>
              </div>
              <p class="cmt-text">${esc(r.content||'')}</p>
              <div class="cmt-actions">
                <button class="cmt-btn${r.is_liked?' liked':''}" id="cmt-like-btn-${r.id}" onclick="nxLikeComment(${r.id},this)">
                  <span class="heart-ic heart-ic-sm" id="cmt-like-icon-${r.id}"><svg viewBox="0 0 24 24"><path d="M12 21s-7.5-4.8-10.2-9.6C.2 8.4 1.4 4.8 4.8 3.6c2.1-.7 4.3 0 5.6 1.7l1.6 2 1.6-2c1.3-1.7 3.5-2.4 5.6-1.7 3.4 1.2 4.6 4.8 3 7.8C19.5 16.2 12 21 12 21z"/></svg></span>
                  <span class="cnt" id="cmt-like-cnt-${r.id}">${r.likes_count>0?r.likes_count:''}</span>
                </button>
                <button class="cmt-btn" onclick="nxOpenReply(${r.id},'${rp}')">Reply</button>
              </div>
            </div>`;
          }).join('')}
        </div>`:''
      }
    </div>`;
  }).join('');
}
function nxToggleReplies(cId){
  const b=$('rep-'+cId); if(!b) return;
  b.classList.toggle('hidden');
  const btn=b.previousElementSibling;
  if(btn){const h=b.classList.contains('hidden'),m=btn.textContent.match(/\d+/),n=m?m[0]:'';btn.textContent=(h?'▸ ':'▾ ')+n+' repl'+(Number(n)===1?'y':'ies');}
}
function nxCommentTyping(){
  const v=$('commentInput').value,w=wordCount(v),ex=w>80;
  $('commentCount').textContent=w+' / 80 words';
  $('commentSubmitBtn').disabled=ex||w===0;
  $('commentInput').classList.toggle('over',ex);
}
async function nxCreateComment(){
  const inp=$('commentInput'),content=inp.value.trim();
  if(!content||wordCount(content)>80||!_curPostId) return;
  $('commentSubmitBtn').disabled=true;
  
  const res=await edgeCall({action:'create_comment',post_id:_curPostId,parent_comment_id:null,content});
  if(!res||!res.ok){showToast(res?.message||'Could not comment.','err');$('commentSubmitBtn').disabled=false;return;}
  
  inp.value=''; nxCommentTyping();

  // Optimistic Update UI directly
  const pIdx = _cache.posts.findIndex(p=>p.id===_curPostId);
  if(pIdx>=0) _cache.posts[pIdx].comments_count = (_cache.posts[pIdx].comments_count||0) + 1;
  const cc=$('cmt-cnt-'+_curPostId);
  if(cc) cc.textContent=Math.max(0,parseInt(cc.textContent||0)+1);

  _commentsCache.delete(_curPostId);
  // Fire-and-forget: comment list refreshes in background, button re-enables immediately
  nxLoadComments(_curPostId);
}

async function nxLikeComment(cId, btnEl){
  if(!sKey()) return;
  const cntEl = $('cmt-like-cnt-'+cId);
  const iconEl = $('cmt-like-icon-'+cId);
  const wasLiked = btnEl && btnEl.classList.contains('liked');

  // Optimistic update locally immediately
  if(wasLiked){
    const newCount = Math.max(0, (parseInt(cntEl?.textContent,10)||0) - 1);
    if(cntEl) cntEl.textContent = newCount>0 ? newCount : '';
    if(btnEl) btnEl.classList.remove('liked');
  } else {
    const newCount = (parseInt(cntEl?.textContent,10)||0) + 1;
    if(cntEl) cntEl.textContent = newCount;
    if(btnEl) btnEl.classList.add('liked');
    if(iconEl){
      iconEl.classList.remove('pop');
      void iconEl.offsetWidth; // restart animation
      iconEl.classList.add('pop');
    }
  }

  // Fire and forget — the server is the source of truth; reopening
  // comments re-fetches is_liked fresh, so no local persistence needed here.
  edgeCall({action:'toggle_comment_like',comment_id:cId}).catch(()=>{});
}

function nxOpenReply(pid,preview){
  _replyParentId=pid;
  $('replyTarget').textContent=preview?'Replying to: '+preview:'Reply to comment';
  const inp=$('replyInput'); if(inp){inp.value='';nxReplyTyping();setTimeout(()=>inp.focus(),10);}
  nxBringToFront('replyModal');
  $('replyModal').style.display='flex';
}
function nxCloseReply(){
  $('replyModal').style.display='none';
  _replyParentId=null;
  nxForceRepaint();
}
function nxReplyTyping(){
  const v=$('replyInput').value,w=wordCount(v),ex=w>80;
  $('replyCount').textContent=w+' / 80 words';
  $('replySubmitBtn').disabled=ex||w===0;
  $('replyInput').classList.toggle('over',ex);
}
async function nxCreateReply(){
  const inp=$('replyInput'),content=inp.value.trim();
  if(!content||wordCount(content)>80||!_curPostId||!_replyParentId) return;
  $('replySubmitBtn').disabled=true;
  const res=await edgeCall({action:'create_comment',post_id:_curPostId,parent_comment_id:_replyParentId,content});
  if(!res||!res.ok){showToast(res?.message||'Could not reply.','err');$('replySubmitBtn').disabled=false;return;}
  nxCloseReply();
  
  // Optimistic UI directly 
  const pIdx = _cache.posts.findIndex(p=>p.id===_curPostId);
  if(pIdx>=0) _cache.posts[pIdx].comments_count = (_cache.posts[pIdx].comments_count||0) + 1;
  const cc=$('cmt-cnt-'+_curPostId);
  if(cc) cc.textContent=Math.max(0,parseInt(cc.textContent||0)+1);

  _commentsCache.delete(_curPostId);
  // Fire-and-forget: comment list refreshes in background
  nxLoadComments(_curPostId);
}

/* ═══════════════════════════════════════════════════
   MENU / PIN / DELETE / EDIT
═══════════════════════════════════════════════════ */
function nxOpenMenu(type,id,mine,isPinned){
  _menuTarget={type,id,isMine:!!mine,isPinned:!!isPinned};
  $('menuDeleteBtn').style.display=mine?'flex':'none';
  $('menuEditBtn').style.display=(type==='dm'&&mine)?'flex':'none';
  const rBtn=$('menuReportBtn');
  rBtn.style.display=mine?'none':'flex';
  const pinBtn=$('menuPinBtn'), unpinBtn=$('menuUnpinBtn');
  if(type==='post'&&isAdmin()){
    pinBtn.classList.toggle('hidden',!!isPinned);
    unpinBtn.classList.toggle('hidden',!isPinned);
  } else {
    pinBtn.classList.add('hidden'); unpinBtn.classList.add('hidden');
  }
  nxBringToFront('menuModal');
  $('menuModal').style.display='flex';
}
function nxCloseMenu(){
  $('menuModal').style.display='none';
  _menuTarget=null;
  nxForceRepaint();
}

async function nxTogglePin(){
  if(!_menuTarget||_menuTarget.type!=='post'||!isAdmin()){nxCloseMenu();return;}
  const pin=!_menuTarget.isPinned;
  const res=await edgeCall({action:'pin_post',post_id:_menuTarget.id,pin});
  if(!res||!res.ok){showToast(res?.message||'Could not update pin.','err');nxCloseMenu();return;}
  nxCloseMenu();
  await nxLoadPosts(true);
  showToast(pin?'Post pinned':'Post unpinned');
}

async function nxDeleteTarget(){
  if(!_menuTarget||!_menuTarget.isMine){nxCloseMenu();return;}
  const t=_menuTarget; let res=null;
  if(t.type==='post')    res=await edgeCall({action:'delete_post',post_id:t.id});
  if(t.type==='comment') res=await edgeCall({action:'delete_comment',comment_id:t.id});
  if(t.type==='dm')      res=await edgeCall({action:'delete_dm',message_id:t.id});
  
  if(!res||!res.ok){showToast(res?.message||'Could not delete.','err');return;}
  nxCloseMenu();
  
  if(t.type==='post'){
    _cache.posts = _cache.posts.filter(p => p.id !== t.id);
    const el = document.querySelector(`.post-card[data-post-id="${t.id}"]`);
    if(el) el.remove();
  }
  if(t.type==='comment'&&_curPostId){
    const pIdx = _cache.posts.findIndex(p=>p.id===_curPostId);
    if(pIdx>=0 && _cache.posts[pIdx].comments_count > 0) _cache.posts[pIdx].comments_count--;
    const cc=$('cmt-cnt-'+_curPostId);
    if(cc) cc.textContent=Math.max(0,parseInt(cc.textContent||0)-1);
    _commentsCache.delete(_curPostId);
    await nxLoadComments(_curPostId);
  }
  showToast('Deleted successfully.');
}

function nxEditTarget(){
  const t=_menuTarget; nxCloseMenu();
  if(!t||t.type!=='dm') return;
  nxStartEditDM(t.id);
}

/* ═══════════════════════════════════════════════════
   REPORT
═══════════════════════════════════════════════════ */
function nxOpenReportForPost(pid){
  _reportPostId=pid; _reportReason=null;
  document.querySelectorAll('.af-btn-secondary-outline').forEach(b=>b.style.borderColor='var(--bc)');
  hide('reportOtherInp'); $('reportSubmitBtn').disabled=true;
  if($('reportOtherInp')) $('reportOtherInp').value='';
  nxBringToFront('reportModal');
  $('reportModal').style.display='flex';
}
function nxOpenReport(){
  const t=_menuTarget; nxCloseMenu();
  if(t&&!t.isMine) nxOpenReportForPost(t.id);
}
function nxCloseReport(){
  $('reportModal').style.display='none';
  _reportPostId=null;
  _reportReason=null;
  nxForceRepaint();
}
function nxSelectReport(btn){
  document.querySelectorAll('#reportOptions button').forEach(b=>{b.style.borderColor='var(--bc)';b.style.background='transparent';});
  btn.style.borderColor='var(--p)'; btn.style.background='var(--p-soft)';
  _reportReason=btn.getAttribute('data-reason');
  if(_reportReason==='Other'){show('reportOtherInp');setTimeout(()=>$('reportOtherInp')&&$('reportOtherInp').focus(),10);}
  else hide('reportOtherInp');
  $('reportSubmitBtn').disabled=!_reportReason;
}
async function nxSubmitReport(){
  if(!_reportPostId||!_reportReason) return;
  const other=($('reportOtherInp').value||'').trim();
  const reason=_reportReason==='Other'?(other||'Other'):_reportReason;
  $('reportSubmitBtn').disabled=true;
  const res=await edgeCall({action:'report_post',post_id:_reportPostId,reason});
  nxCloseReport();
  if(!res||!res.ok){showToast(res?.message||'Could not submit report.','err');return;}
  showToast('Report submitted. Thank you.');
}

/* ═══════════════════════════════════════════════════
   BLOCK / UNBLOCK SYSTEM
═══════════════════════════════════════════════════ */
async function nxLoadBlockedUsers(){
  const res = await edgeCall({action:'get_blocked'});
  if(res && res.ok && res.users){
    _cache.blockedKeys = new Set(res.users.map(u => u.student_key));
  }
}

function nxOpenMainMenu(){
  nxBringToFront('mainMenuModal');
  $('mainMenuModal').style.display='flex';
}
function nxCloseMainMenu(){
  $('mainMenuModal').style.display='none';
  nxForceRepaint();
}

async function nxOpenBlockedUsers(){
  nxCloseMainMenu();
  $('blockListBody').innerHTML='<div class="state-msg">Loading…</div>';
  nxBringToFront('blockListModal');
  $('blockListModal').style.display='flex';
  
  const res = await edgeCall({action:'get_blocked'});
  const box = $('blockListBody');
  if(!res || !res.ok || !res.users || !res.users.length){
    box.innerHTML='<div class="state-msg"><span>No blocked users.</span></div>';
    return;
  }
  
  box.innerHTML = res.users.map(u => {
    return `<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 18px;border-bottom:1px solid var(--b1);">
      <div style="display:flex;align-items:center;gap:12px;flex:1;min-width:0;">
        ${avatarHTML(u.student_name, u.emoji||'', u.avatar_url||'', ' avatar-sm', '', !!u.is_verified)}
        <div style="font-family:var(--fd);font-size:14px;font-weight:800;color:var(--t1);">${esc(u.student_name)}</div>
      </div>
      <button class="af-btn-secondary-outline" style="height:32px;font-size:12px;padding:0 12px;flex-shrink:0;color:var(--t1);" onclick="nxUnblockFromList('${esc(u.student_key)}')">Unblock</button>
    </div>`;
  }).join('');
}

function nxCloseBlockedUsers(){
  $('blockListModal').style.display='none';
  nxForceRepaint();
}

async function nxBlockCurrentPeer(){
  if(!_dmPeer) return;
  const key = _dmPeer.key;
  nxCloseDMOptions();
  const res = await edgeCall({action:'block_user', target_key:key});
  if(res && res.ok){
    _cache.blockedKeys.add(key);
    showToast('User blocked.');
    if($('dmScreen').style.display==='flex' && _dmPeer.key === key){
      show('dmBlockedBanner');
      $('dmBlockedBanner').textContent = 'You have blocked this user.';
      $('dmInput').disabled = true;
      $('dmSendBtn').disabled = true;
    }
  } else {
    showToast(res?.message||'Could not block user.','err');
  }
}

async function nxUnblockCurrentPeer(){
  if(!_dmPeer) return;
  const key = _dmPeer.key;
  nxCloseDMOptions();
  const res = await edgeCall({action:'unblock_user', target_key:key});
  if(res && res.ok){
    _cache.blockedKeys.delete(key);
    showToast('User unblocked.');
    if($('dmScreen').style.display==='flex' && _dmPeer.key === key){
      hide('dmBlockedBanner');
      $('dmInput').disabled = false;
      nxDMTyping(); 
    }
  } else {
    showToast(res?.message||'Could not unblock user.','err');
  }
}

async function nxUnblockFromList(key){
  const res = await edgeCall({action:'unblock_user', target_key:key});
  if(res && res.ok){
    _cache.blockedKeys.delete(key);
    showToast('User unblocked.');
    nxOpenBlockedUsers();
    if(_dmPeer && _dmPeer.key === key){
      hide('dmBlockedBanner');
      $('dmInput').disabled = false;
    }
  } else {
    showToast(res?.message||'Could not unblock user.','err');
  }
}

/* ═══════════════════════════════════════════════════
   PROFILE (with in-memory cache for thumbnails)
═══════════════════════════════════════════════════ */

/** Returns the story group for a given student_key, or null if none. */
function nxGetUserStoryGroup(key){
  if(!key || !_storyGroups) return null;
  return _storyGroups.find(g=>String(g.student_key)===String(key)) || null;
}

/** Apply story ring to profileAvatar based on whether user has an active story. */
function _applyProfileStoryRing(key){
  const avatarEl=$('profileAvatar');
  if(!avatarEl) return;
  const grp = nxGetUserStoryGroup(key);
  if(grp && grp.stories && grp.stories.length){
    const hasUnviewed = !!grp.has_unviewed;
    avatarEl.classList.remove('story-ring-active','story-ring-seen');
    avatarEl.classList.add(hasUnviewed ? 'story-ring-active' : 'story-ring-seen');
    avatarEl.title = hasUnviewed ? 'View story' : 'View story (seen)';
    avatarEl.onclick = ()=>{
      const grpIdx=_storyGroups.indexOf(grp);
      if(grpIdx>=0) nxOpenStoryViewer(grpIdx);
    };
  } else {
    avatarEl.classList.remove('story-ring-active','story-ring-seen');
    avatarEl.title = '';
    avatarEl.onclick = null;
  }
}

async function nxOpenProfile(key,name){
  if(!key) return;
  _profileData={key,name};
  $('profileHdrName').textContent=name;
  $('profileName').textContent=name;
  $('profileAvatar').className='avatar avatar-lg initials';
  $('profileAvatar').innerHTML=esc(initials(name));
  $('profileTopCard').className='';
  $('profileTopCard').setAttribute('style','padding:24px 20px;background:var(--card-s);border-bottom:1px solid var(--b1);');
  $('profileUsername').textContent='';
  $('profileBio').textContent='';
  $('profileFollowersCount').textContent='0';
  $('profileFollowingCount').textContent='0';
  $('profileFollowBtn').textContent='Follow';
  $('profileFollowBtn').className='af-btn-primary';
  $('profileFollowBtn').style.display=key===sKey()?'none':'flex';
  $('profileMessageBtn').style.display=key===sKey()?'none':'flex';
  const _pfyBadge=$('profileFollowsYouBadge');
  if(_pfyBadge) _pfyBadge.style.display='none';
  $('profilePostsList').innerHTML='<div class="state-msg">Loading…</div>';
  $('profilePageScroll').scrollTop=0;

  // Render cached thumbnail instantly if available
  const cached = _cache.profiles.get(key);
  if(cached){
    _applyProfileUI(cached, false);
  }

  nxBringToFront('profileScreen');
  $('profileScreen').style.display='flex';
  // Story ring: apply immediately if we already have story data in memory
  _applyProfileStoryRing(key);
  nxLoadProfileMeta(key);
  nxLoadProfilePosts(key);
}
function nxCloseProfile(){
  $('profileScreen').style.display='none';
  _profileData=null;
  nxForceRepaint();
}

function _applyProfileUI(p, isFull){
  const isVer=!!p.is_verified;
  const avatarEl=$('profileAvatar');
  if(p.avatar_url){
    avatarEl.className='avatar avatar-lg'+(isVer?' gold-avatar-frame':'');
    avatarEl.innerHTML=`<img src="${esc(p.avatar_url)}" style="width:100%;height:100%;object-fit:cover;border-radius:18px;" loading="lazy" onerror="this.parentElement.className='avatar avatar-lg initials';this.parentElement.innerHTML='${esc(initials(p.student_name||'AF'))}'"/>`;
  } else if(p.emoji){
    avatarEl.className='avatar avatar-lg'+(isVer?' gold-avatar-frame':'');
    avatarEl.innerHTML=p.emoji;
  }
  if(isVer){
    $('profileName').innerHTML=`<span class="gold-name">${esc(p.student_name)}</span> ${verBadgeHTML(true)}`;
    $('profileTopCard').setAttribute('style','padding:24px 20px;background:linear-gradient(135deg,rgba(245,158,11,.08),rgba(251,191,36,.06));border-bottom:1px solid rgba(245,158,11,.3);position:relative;overflow:hidden;');
    // Gold top bar on profile card
    const existingBar = $('profileTopCard').querySelector('.gold-topbar');
    if(!existingBar){
      const bar=document.createElement('div');
      bar.className='gold-topbar';
      bar.style.cssText='position:absolute;top:0;left:0;right:0;height:2px;background:linear-gradient(90deg,#f59e0b,#fbbf24,#d97706);';
      $('profileTopCard').prepend(bar);
    }
  } else {
    $('profileName').innerHTML=esc(p.student_name||'Student');
    $('profileTopCard').setAttribute('style','padding:24px 20px;background:var(--card-s);border-bottom:1px solid var(--b1);');
  }
  if(p.username) $('profileUsername').textContent='@'+p.username;
  if(p.bio) $('profileBio').textContent=p.bio;
}

async function nxLoadProfileMeta(key){
  const res=await edgeCall({action:'get_profile',target_key:key});
  if(!res||!res.ok) return;
  if(res.profile){
    // Cache the profile
    _cache.profiles.set(key, res.profile);
    _applyProfileUI(res.profile, true);
  }
  $('profileFollowersCount').textContent=res.followers_count||0;
  $('profileFollowingCount').textContent=res.following_count||0;
  _profileIsFollowing=!!res.is_following;
  const _theyFollowMe=!!res.they_follow_me;
  // Store on _profileData so nxMessageFromProfile can use it
  if(_profileData && _profileData.key===key){
    _profileData.is_following=_profileIsFollowing;
    _profileData.they_follow_me=_theyFollowMe;
  }
  if(key!==sKey()){
    // "Follows you" badge — real data, no fabrication
    const _fyBadge=$('profileFollowsYouBadge');
    if(_fyBadge) _fyBadge.style.display=_theyFollowMe?'inline-block':'none';
    // Button: "Follow Back" when they follow me but I don't follow them
    if(!_profileIsFollowing && _theyFollowMe){
      $('profileFollowBtn').textContent='Follow Back';
      $('profileFollowBtn').className='af-btn-primary';
    } else {
      $('profileFollowBtn').textContent=_profileIsFollowing?'Following':'Follow';
      $('profileFollowBtn').className=_profileIsFollowing?'af-btn-secondary-outline':'af-btn-primary';
    }
  }
  // Re-apply story ring in case stories were loaded after the profile was shown
  _applyProfileStoryRing(key);
}
async function nxToggleFollow(){
  if(!_profileData) return;
  const res=await edgeCall({action:'toggle_follow',target_key:_profileData.key});
  if(!res||!res.ok){showToast(res?.message||'Could not update follow.','err');return;}
  _profileIsFollowing=!!res.following;
  const _stillFollowsMe=!!(_profileData&&_profileData.they_follow_me);
  if(!_profileIsFollowing && _stillFollowsMe){
    $('profileFollowBtn').textContent='Follow Back';
    $('profileFollowBtn').className='af-btn-primary';
  } else {
    $('profileFollowBtn').textContent=_profileIsFollowing?'Following':'Follow';
    $('profileFollowBtn').className=_profileIsFollowing?'af-btn-secondary-outline':'af-btn-primary';
  }
  // Update local following cache
  if(_profileIsFollowing){
    _cache.followingKeys.add(_profileData.key);
  } else {
    _cache.followingKeys.delete(_profileData.key);
  }
  nxRenderSuggestedUsers(); // refresh suggested list in DMs tab
  const c=$('profileFollowersCount');
  c.textContent=Math.max(0,Number(c.textContent||0)+(_profileIsFollowing?1:-1));
  // Update following keys cache
  if(_profileIsFollowing) _cache.followingKeys.add(String(_profileData.key));
  else _cache.followingKeys.delete(String(_profileData.key));
}
async function nxLoadProfilePosts(key){
  const res=await edgeCall({action:'student_posts',target_key:key});
  const box=$('profilePostsList'); if(!box) return;
  if(!res||!res.ok){box.innerHTML='<div class="state-msg"><span>Could not load.</span></div>';return;}
  renderListToContainer(res.posts,'profilePostsList',false);
}

function nxMessageFromProfile(){
  if(!_profileData||_profileData.key===sKey()) return;
  // Mutual follow check: both users must follow each other to DM
  const iFollowThem = !!_profileData.is_following;
  // Check if they follow me back using cached follower list
  const followerKeys = new Set(_cache.myFollowers.map(u=>(u.student_key||u.follower_key||u.key||'')));
  // they_follow_me is now populated from get_profile; fallback to local follower cache
  const theyFollowMe = !!_profileData.they_follow_me || followerKeys.has(_profileData.key);
  if(!iFollowThem || !theyFollowMe){
    nxOpenNoMutualFollowModal(_profileData.name || _profileData.student_name);
    return;
  }
  nxOpenDM(_profileData.key, _profileData.name);
}

/* ═══════════════════════════════════════════════════
   MY PROFILE
═══════════════════════════════════════════════════ */
function nxOpenMyProfile(){
  const n=sName(), e=getMyEmoji(), u=getMyUsername(), avatarUrl=getMyAvatarUrl();
  $('myProfileName').textContent=n;
  $('myProfileUsername').textContent=u?'@'+u:'No username set';
  $('myProfileBio').textContent=localStorage.getItem('af_bio')||'';
  const avatarInner=$('myProfileAvatarInner');
  if(avatarUrl){
    avatarInner.innerHTML=`<img src="${esc(avatarUrl)}" style="width:72px;height:72px;object-fit:cover;" loading="lazy" onerror="this.parentElement.innerHTML='${esc(initials(n))}'"/>`;
    avatarInner.style.cssText='width:72px;height:72px;border-radius:18px;overflow:hidden;background:var(--p);color:#fff;';
  } else if(e){
    avatarInner.innerHTML=e;
    avatarInner.style.cssText='width:72px;height:72px;border-radius:18px;overflow:hidden;display:flex;align-items:center;justify-content:center;font-size:32px;background:var(--p-soft);';
  } else {
    avatarInner.innerHTML=`<span style="font-size:22px;font-weight:800;">${esc(initials(n))}</span>`;
    avatarInner.style.cssText='width:72px;height:72px;border-radius:18px;overflow:hidden;display:flex;align-items:center;justify-content:center;font-size:22px;background:var(--p);color:#fff;';
  }
  // Story ring on my avatar if I have an active story
  const myStoryGrp = _storyGroups && _storyGroups.find(g=>g.is_mine);
  const avatarWrap = avatarInner.parentElement;
  if(avatarWrap){
    if(myStoryGrp && myStoryGrp.stories && myStoryGrp.stories.length){
      avatarWrap.style.boxShadow='0 0 0 3px var(--card-s),0 0 0 6px #f43f5e';
      avatarWrap.style.borderRadius='22px';
      avatarWrap.style.cursor='pointer';
      avatarWrap.title='View your story';
      avatarWrap.onclick=()=>{
        const grpIdx=_storyGroups.indexOf(myStoryGrp);
        if(grpIdx>=0){ nxCloseMyProfile(); nxOpenStoryViewer(grpIdx); }
      };
    } else {
      avatarWrap.style.boxShadow='';
      avatarWrap.style.cursor='';
      avatarWrap.title='';
      avatarWrap.onclick=null;
    }
  }
  $('myProfilePageScroll').scrollTop=0;
  nxBringToFront('myProfileScreen');
  $('myProfileScreen').style.display='flex';
  nxLoadMyProfileData();
}
function nxCloseMyProfile(){
  $('myProfileScreen').style.display='none';
  nxForceRepaint();
}
async function nxLoadMyProfileData(){
  // get_my_profile and my_posts are independent reads — run in parallel (halves RTT cost)
  const [res, res2] = await Promise.all([
    edgeCall({action:'get_my_profile'}),
    edgeCall({action:'my_posts'}),
  ]);
  if(res&&res.ok){
    $('myProfileFollowersCount').textContent=res.followers_count||0;
    $('myProfileFollowingCount').textContent=res.following_count||0;
    _cache.myVerified = !!res.profile?.is_verified;
  }
  if(res2&&res2.ok&&Array.isArray(res2.posts)){
    $('myProfilePostsCount').textContent=res2.posts.length||0;
    renderListToContainer(res2.posts,'myProfilePostsList',false);
  }
}
window.nxOpenMyProfile=nxOpenMyProfile;
window.nxCloseMyProfile=nxCloseMyProfile;

/* ═══════════════════════════════════════════════════
   FOLLOW LIST
═══════════════════════════════════════════════════ */
async function nxOpenFollowers(){await loadFollowList('followers',sKey());}
async function nxOpenFollowing(){await loadFollowList('following',sKey());}
async function nxOpenFollowersFor(){if(_profileData) await loadFollowList('followers',_profileData.key);}
async function nxOpenFollowingFor(){if(_profileData) await loadFollowList('following',_profileData.key);}

function _renderFollowListBox(list){
  const box=$('followListBody');
  if(!list.length){box.innerHTML='<div class="state-msg"><span>No users here yet.</span></div>';return;}
  box.innerHTML=list.map(u=>{
    const key=String(u.student_key||u.key||u.follower_key||u.following_key||'');
    const name=u.student_name||u.name||'Student';
    const username=u.username||'';
    const emoji=u.emoji||'';
    const avatarUrl=u.avatar_url||'';
    const isVer=!!u.is_verified;
    const safeKey=esc(key);
    const safeName=esc(name).replace(/'/g,'&#39;');
    const nameHtml = isVer
      ? `<span class="gold-name">${esc(name)}</span>${verBadgeHTML(true)}`
      : esc(name);
    let actionBtns='';
    if(_followListIsOwn){
      if(_followListType==='following'){
        actionBtns=`<button onclick="event.stopPropagation();nxUnfollowFromList('${safeKey}','${safeName}',this)" style="flex-shrink:0;padding:6px 14px;border-radius:20px;border:1.5px solid var(--tm);background:transparent;color:var(--tm);font-size:12px;font-weight:700;cursor:pointer;font-family:var(--fd);">Unfollow</button>`;
      } else {
        actionBtns=`<button onclick="event.stopPropagation();nxRemoveFollowerFromList('${safeKey}','${safeName}',this)" style="flex-shrink:0;padding:6px 12px;border-radius:20px;border:1.5px solid var(--tm);background:transparent;color:var(--tm);font-size:12px;font-weight:700;cursor:pointer;font-family:var(--fd);">Remove</button>
          <button onclick="event.stopPropagation();nxBlockFromFollowerList('${safeKey}','${safeName}',this)" title="Block user" style="flex-shrink:0;width:32px;height:32px;border-radius:50%;border:1.5px solid var(--b1);background:transparent;color:var(--tm);font-size:18px;font-weight:900;cursor:pointer;line-height:1;display:flex;align-items:center;justify-content:center;">⋯</button>`;
      }
    }
    return `<div data-follow-row="${safeKey}" style="display:flex;align-items:center;gap:12px;padding:12px 18px;border-bottom:1px solid var(--b1);" onclick="nxCloseFollowList();nxOpenProfile('${safeKey}','${safeName}')">
      <div style="flex-shrink:0;cursor:pointer;">${avatarHTML(name,emoji,avatarUrl,' avatar-sm','',isVer)}</div>
      <div style="flex:1;min-width:0;cursor:pointer;">
        <div style="font-family:var(--fd);font-size:14px;font-weight:800;color:var(--t1);display:flex;align-items:center;gap:0;">
          ${nameHtml}
        </div>
        ${username?`<div style="font-size:12px;color:var(--tm);font-weight:600;margin-top:2px;">@${esc(username)}</div>`:'<div style="font-size:12px;color:var(--tm);margin-top:2px;">No username set</div>'}
      </div>
      ${actionBtns?`<div style="display:flex;align-items:center;gap:6px;flex-shrink:0;">${actionBtns}</div>`:''}
    </div>`;
  }).join('');
}

async function loadFollowList(type,targetKey){
  _followListType=type;
  _followListIsOwn=(targetKey===sKey());
  $('followListTitle').textContent=type==='followers'?'Followers':'Following';
  nxBringToFront('followListModal');
  $('followListModal').style.display='flex';

  // INSTANT PAINT: my own followers/following are already sitting in
  // memory (fetched in parallel at app start by nxPreloadConnections),
  // so opening this modal for myself should feel instant — no spinner —
  // exactly like Instagram opening your own followers list. We still
  // quietly refresh from the network after, in case it changed since
  // app start. Other people's lists aren't cached, so those still show
  // a brief loading state.
  const isOwnList = targetKey===sKey();
  const cachedList = isOwnList ? (type==='followers'?_cache.myFollowers:_cache.myFollowing) : null;
  if(Array.isArray(cachedList) && cachedList.length){
    _renderFollowListBox(cachedList);
  } else {
    $('followListBody').innerHTML='<div class="state-msg">Loading…</div>';
  }

  const action=type==='followers'?'get_followers':'get_following';
  const res=await edgeCall({action,target_key:targetKey});
  // Guard against the modal having been closed/reopened for a different
  // list while this request was in flight.
  if($('followListModal').style.display!=='flex' || $('followListTitle').textContent!==(type==='followers'?'Followers':'Following')) return;
  const list=res&&res.ok&&Array.isArray(res.users)?res.users:null;
  if(list===null){
    // Network/server failure: keep whatever we already painted (cached
    // or otherwise) rather than wiping it out with an empty state.
    if(!cachedList || !cachedList.length){
      $('followListBody').innerHTML='<div class="state-msg"><span>No users here yet.</span></div>';
    }
    return;
  }
  if(isOwnList){
    if(type==='followers') _cache.myFollowers=list;
    else {
      _cache.myFollowing=list;
      _cache.followingKeys=new Set(list.map(u=>String(u.student_key||'')));
    }
    saveSnapshot(type==='followers'?'followers_me':'following_me', list);
  }
  _renderFollowListBox(list);
}
function nxCloseFollowList(){
  $('followListModal').style.display='none';
  nxForceRepaint();
}

async function nxUnfollowFromList(key, name, btn){
  if(!key) return;
  btn.disabled=true; btn.textContent='…';
  const res=await edgeCall({action:'toggle_follow',target_key:key});
  if(res && res.ok && !res.following){
    _cache.followingKeys.delete(key);
    _cache.myFollowing=_cache.myFollowing.filter(u=>String(u.student_key||u.key||'')!==key);
    showToast('Unfollowed '+name+'.');
    const row=btn.closest('[data-follow-row]');
    if(row){row.style.transition='opacity .3s';row.style.opacity='0';setTimeout(()=>row.remove(),300);}
  } else {
    btn.disabled=false; btn.textContent='Unfollow';
    showToast(res?.message||'Could not unfollow.','err');
  }
}

async function nxRemoveFollowerFromList(key, name, btn){
  if(!key) return;
  if(!confirm('Remove '+name+' from your followers?')) return;

  // OPTIMISTIC: remove row + update cache immediately — UI unfreezes at once
  const row=btn.closest('[data-follow-row]');
  if(row){row.style.transition='opacity .2s';row.style.opacity='0';setTimeout(()=>row.remove(),200);}
  _cache.myFollowers=_cache.myFollowers.filter(u=>String(u.student_key||u.key||u.follower_key||'')!==key);
  saveSnapshot('followers_me',_cache.myFollowers);
  showToast(name+' removed from followers.');

  // Background: block then unblock (must stay sequential — block first)
  // Neither call needs to block the UI; we already showed optimistic feedback.
  const r1=await edgeCall({action:'block_user',target_key:key});
  if(r1 && r1.ok){
    edgeCall({action:'unblock_user',target_key:key}).catch(()=>{});
  } else {
    // Revert on failure: reload fresh list so the removed row reappears
    showToast(r1?.message||'Could not remove follower. Tap Followers to refresh.','err');
    loadFollowList('followers',sKey());
  }
}

async function nxBlockFromFollowerList(key, name, btn){
  if(!key) return;
  if(!confirm('Block '+name+'? They won\'t be able to follow you or send DMs.')) return;
  btn.disabled=true;
  const res=await edgeCall({action:'block_user',target_key:key});
  if(res && res.ok){
    _cache.blockedKeys.add(key);
    _cache.myFollowers=_cache.myFollowers.filter(u=>String(u.student_key||u.key||u.follower_key||'')!==key);
    saveSnapshot('followers_me',_cache.myFollowers);
    showToast(name+' blocked.');
    const row=btn.closest('[data-follow-row]');
    if(row){row.style.transition='opacity .3s';row.style.opacity='0';setTimeout(()=>row.remove(),300);}
  } else {
    btn.disabled=false;
    showToast(res?.message||'Could not block user.','err');
  }
}

