/* ═══════════════════════════════════════════════════
   DM OPTIONS / CLEAR CHAT HISTORY
═══════════════════════════════════════════════════ */
function nxOpenNoMutualFollowModal(peerName){
  const msg=$('noMutualFollowMsg');
  if(msg) msg.textContent=(peerName?'To message '+peerName+', you need to follow each other. Follow them first — once they follow you back, DMs unlock automatically.':'You need to follow each other to send messages. Follow them first — once they follow you back, DMs will be unlocked.');
  const el=$('noMutualFollowModal');
  if(el){ nxBringToFront('noMutualFollowModal'); el.style.display='flex'; }
}
function nxCloseNoMutualFollowModal(){
  const el=$('noMutualFollowModal');
  if(el) el.style.display='none';
  nxForceRepaint();
}
window.nxOpenNoMutualFollowModal=nxOpenNoMutualFollowModal;
window.nxCloseNoMutualFollowModal=nxCloseNoMutualFollowModal;

function nxOpenDMOptions(){
  if(!_dmPeer) return;
  const isBlocked = _cache.blockedKeys.has(_dmPeer.key);
  $('dmBlockBtn').style.display = isBlocked ? 'none' : 'flex';
  $('dmUnblockBtn').style.display = isBlocked ? 'flex' : 'none';
  nxBringToFront('dmOptionsModal');
  $('dmOptionsModal').style.display='flex';
}
function nxCloseDMOptions(){
  $('dmOptionsModal').style.display='none';
  nxForceRepaint();
}
function nxOpenClearChatConfirm(){
  if(!_dmPeer) return;
  nxCloseDMOptions();
  $('clearChatPeerName').textContent=_dmPeer.name||'this user';
  $('clearChatConfirmBtn').disabled=false;
  $('clearChatConfirmBtn').textContent='Clear for me';
  nxBringToFront('clearChatModal');
  $('clearChatModal').style.display='flex';
}
function nxCloseClearChatConfirm(){
  $('clearChatModal').style.display='none';
  nxForceRepaint();
}

/**
 * Clears the conversation history for the current user.
 * The other participant will still be able to see the messages.
 */
async function nxConfirmClearChat(){
  if(!_dmPeer) return;
  const peerKey=_dmPeer.key;
  $('clearChatConfirmBtn').disabled=true;
  $('clearChatConfirmBtn').textContent='Clearing…';
  const res=await edgeCall({action:'clear_chat_history',peer_key:peerKey});
  if(!res||!res.ok){
    $('clearChatConfirmBtn').disabled=false;
    $('clearChatConfirmBtn').textContent='Clear for me';
    showToast(res?.message||'Could not clear chat history. The server may not support this yet.','err');
    return;
  }
  // Server confirmed deletion — now clear it from local state too.
  const chatIdx=_cache.chatList.findIndex(c=>c.peer.student_key===peerKey);
  if(chatIdx>=0) _cache.chatList.splice(chatIdx,1);
  _cache.chatReadTs.delete(peerKey);
  saveChatReadTs();
  nxCloseClearChatConfirm();
  nxCloseDM();
  nxUpdateUnreadBadge();
  if(_activeTab==='chats') nxRenderChatList();
  showToast('Chat history cleared.');
}

function nxRenderDMMessages(msgs, searchTerm=''){
  const box=$('dmMessages'); if(!box) return;
  if(!_dmPeer) return;
  if(!msgs||!msgs.length){
    box.innerHTML='<div class="state-msg"><span>💬</span><span>Say hello!</span></div>';
    return;
  }
  const chatObj=_cache.chatList.find(c=>c.peer.student_key===_dmPeer.key);
  // Also check profile cache for verification status
  const cachedP = _cache.profiles.get(_dmPeer.key);
  const peerVer=chatObj?!!chatObj.peer.is_verified:(cachedP?!!cachedP.is_verified:false);
  const peerEmoji=chatObj?chatObj.peer.emoji:'';
  const peerAvatarUrl=chatObj?chatObj.peer.avatar_url||'':'';
  // Normalise search term for case-insensitive matching
  const srchLow=searchTerm.toLowerCase();

  // Track oldest ts for swipe-up pagination
  const realMsgs=msgs.filter(m=>!m.is_deleted&&!m.text?.match(_RX_RE));
  if(realMsgs.length) _dmOldestTs=realMsgs[0].ts;

  // Find the last message I sent (for seen receipt)
  const myMsgs=msgs.filter(m=>m.sender===sKey()&&!m.is_deleted&&!m.text?.match(_RX_RE));
  const lastMyMsgId=myMsgs.length?String(myMsgs[myMsgs.length-1].id):null;

  // Build reaction map before looping — reaction messages are rendered as chips, not bubbles
  const rxMap=_buildRxMap(msgs);
  box.innerHTML=msgs.map((m,i)=>{
    // Explicitly parse boolean for me so undefined sender bugs don't happen
    const me = (m.sender === sKey()); 
    const deleted=!!m.is_deleted;
    const rawText = m.text || '';
    // Skip reaction messages — they appear as chips below their target bubble
    if(!deleted && rawText.match(_RX_RE)) return '';
    // For consecutive detection, skip over any reaction-only messages in history
    const prevReal = msgs.slice(0,i).reverse().find(p=>!p.text||!p.text.match(_RX_RE));
    const isConsecutive=!!(prevReal&&prevReal.sender===m.sender&&!prevReal.is_deleted);
    const clickAction=(me&&!deleted&&m.id)?` onclick="nxOpenMenu('dm',${m.id},true,false)"`:'';
    // Gold bubble for verified peer messages
    const bubbleExtraClass=(!me&&peerVer)?' gold-bubble':'';

    // Determine if this message matches the search term
    const isMatch=srchLow&&!deleted&&rawText.toLowerCase().includes(srchLow);

    // Assemble the image preview if image URL is present and completely valid
    const isValidImg = m.image_url && m.image_url !== 'null' && m.image_url !== 'undefined';
    const imgHtml = (!deleted && isValidImg) 
      ? `<img src="${esc(m.image_url)}" onclick="nxOpenLightbox(this.src)" style="max-width:220px; border-radius:${m.text?'10px 10px 4px 4px':'10px'}; margin-bottom:${m.text?'6px':'0'}; display:block; max-height:220px; object-fit:cover; cursor:zoom-in;"/>` 
      : '';

    // Detect DM reply-to prefix: ↩[msgId] quotedText\nactualMessage
    const STORY_REPLY_PREFIX = '\u21A9 Replied to your story:\n';
    const isStoryReply = !deleted && rawText.startsWith(STORY_REPLY_PREFIX);
    const replyMatch = !deleted && !isStoryReply && rawText.match(_DM_REPLY_RE);
    let displayText = rawText;
    let replyQuoteHtml = '';
    if(replyMatch){
      const [,, quotedText, bodyText] = replyMatch;
      displayText = bodyText;
      replyQuoteHtml = `<span class="dm-reply-quote">${esc(quotedText)}</span>`;
    }

    let textHtml;
    if(deleted){
      textHtml = 'Message deleted';
    } else if(isStoryReply){
      const replyBody = _hlText(rawText.slice(STORY_REPLY_PREFIX.length), searchTerm);
      textHtml = `<div class="story-reply-badge">↩ Replied to story</div><div class="story-reply-body">${replyBody}</div>`;
    } else {
      textHtml = _hlText(displayText, searchTerm);
    }

    // Reaction chips rendered BELOW the bubble so they never overlap text
    const rxHtml = (m.id && !deleted) ? _renderRxChips(m.id, rxMap) : '';

    // Delivery / read receipt on the last message I sent
    const isLastMine = me && !deleted && String(m.id)===lastMyMsgId;
    let tickHtml = '';
    if(isLastMine){
      if(_dmPeerReadAt && new Date(m.ts)<=new Date(_dmPeerReadAt)){
        tickHtml = '<div class="bubble-tick seen">Seen ✓</div>';
      } else {
        tickHtml = '<div class="bubble-tick sent">✓</div>';
      }
    }

    // Safe text attr for long-press reply (encode for inline event)
    const msgTextAttr = !deleted ? esc(displayText).replace(/'/g,'&#39;').replace(/"/g,'&quot;') : '';

    // NOTE: This literal absolutely MUST NOT contain interior white space or newlines between <div class="bubble..."> and </div>
    // Otherwise `white-space: pre-wrap;` injects those hidden characters and stretches out the bubble.
    return `<div class="bubble-wrap${me?' me':''}${isConsecutive?' consecutive':''}${isMatch?' dm-search-match':''}"${clickAction}>
      <span class="bubble-reply-hint">↩</span>
      ${!me?(isConsecutive?'<div class="bubble-avatar-slot"></div>':avatarHTML(_dmPeer.name,peerEmoji,peerAvatarUrl,' bubble-avatar-slot',`nxOpenProfile('${esc(_dmPeer.key)}','${esc(_dmPeer.name).replace(/'/g,"&#39;")}')`,peerVer)):''}
      <div style="display:flex;flex-direction:column;align-items:${me?'flex-end':'flex-start'};max-width:72%;min-width:0;">
        <div class="bubble${deleted?' deleted':''}${bubbleExtraClass}${isStoryReply?' story-reply-bubble':''}" data-msg-id="${m.id||''}" data-msg-text="${msgTextAttr}" style="${(!deleted && !m.text && isValidImg) ? 'padding:4px;' : ''}">${replyQuoteHtml}${imgHtml}${textHtml}</div>
        ${rxHtml}
        <div class="bubble-meta${me?' me':''}">
          <div class="bubble-time">${esc(timeAgo(m.ts))}</div>
        </div>
        ${tickHtml}
      </div>
    </div>`;
  }).join('');
  box.scrollTop=box.scrollHeight;
}

/* ═══════════════════════════════════════════════════
   DM IMAGE UPLOADING
═══════════════════════════════════════════════════ */
// Only Premium (verified) members can send photos in chat — mirrors the
// existing story-posting restriction. Block-status (handled above) always
// wins over premium state: a blocked thread stays disabled regardless.
function nxApplyDMAttachGate(){
  const btn=$('dmAttachBtn');
  const input=$('dmImageInput');
  if(!btn) return;
  const blockedOut = !!(input && input.disabled);
  btn.style.opacity = (!blockedOut && _cache.myVerified) ? '1' : '.4';
}
function nxAttachDMImage(){
  const input=$('dmImageInput');
  if(input && input.disabled) return; // blocked thread — banner already explains why
  if(!_cache.myVerified){
    showToast('Only Premium members can send photos in chat. Premium is unlocked automatically based on your activity and contribution. Keep posting and engaging!', 'err');
    return;
  }
  if(input) input.click();
}
function nxHandleDMImage(input) {
  const file = input.files && input.files[0];
  if (!file) return;
  if(!_cache.myVerified){
    // Defense in depth — in case this handler is ever reached without
    // going through the nxAttachDMImage() gate above.
    showToast('Only Premium members can send photos in chat. Premium is unlocked automatically based on your activity and contribution. Keep posting and engaging!', 'err');
    input.value='';
    return;
  }
  if (file.size > 2*1024*1024) { showToast('Please reduce the image size to less than 2 MB and try again.','err'); return; }
  const reader = new FileReader();
  reader.onload = e => {
    _dmPendingImage = e.target.result;
    $('dmImagePreview').src = _dmPendingImage;
    show('dmImagePreviewWrap');
    nxDMTyping();
  };
  reader.readAsDataURL(file);
}

function nxRemoveDMImage() {
  _dmPendingImage = null;
  const input = $('dmImageInput');
  if(input) input.value = '';
  hide('dmImagePreviewWrap');
  nxDMTyping();
}

/* ═══════════════════════════════════════════════════
   DM INPUT
═══════════════════════════════════════════════════ */
function nxDMTyping(){
  const v=($('dmInput').value||'').trim();
  $('dmSendBtn').disabled = !(v || _dmPendingImage);
  // Broadcast typing signal to peer while there is text in the box
  if(v) nxSendTypingSignal();
}

async function nxSendDM(){
  const inp=$('dmInput'),text=inp.value.trim();
  if(!text && !_dmPendingImage) return;

  if(_dmPendingImage && !_dmEditingId && !text){
    showToast('Please add a message to send with your photo.','err');
    return;
  }

  if(_dmEditingId){
    if(_dmPendingImage) {
      showToast('Cannot add image to edited message.', 'err');
      return;
    }
    $('dmSendBtn').disabled=true;
    const res=await edgeCall({action:'edit_dm',message_id:_dmEditingId,text});
    if(!res||!res.ok){showToast(res?.message||'Could not edit.','err');$('dmSendBtn').disabled=false;return;}
    nxCancelEditDM();
    inp.value=''; nxDMTyping();
    // Reflect the edited text immediately in the open thread.
    const chatObjEdit=_cache.chatList.find(c=>c.peer.student_key===_dmPeer.key);
    if(chatObjEdit){
      const m=chatObjEdit.messages.find(x=>String(x.id)===String(_dmEditingId));
      if(m) m.text=text;
      nxRenderDMMessages(chatObjEdit.messages);
    }
    return;
  }
  
  $('dmSendBtn').disabled=true;
  inp.value='';
  nxStopTypingSignal(); // stop broadcasting typing when message is sent
  const imgData = _dmPendingImage;
  nxRemoveDMImage(); // clear attachment from UI immediately

  // Build the final text — prefix with reply-to if one is active
  let finalText = text;
  if(_dmReplyTo && text){
    const quotedPreview = (_dmReplyTo.text||'').slice(0,80);
    finalText = `\u21A9[${_dmReplyTo.id}] ${quotedPreview}\n${text}`;
    nxCancelDMReply();
  } else if(_dmReplyTo){
    nxCancelDMReply();
  }
  
  const payload = {action:'send_dm', to_key:_dmPeer.key, to_name:_dmPeer.name, text:finalText};
  if(imgData) payload.image_data_url = imgData;

  // ── Optimistic paint ── show the bubble immediately before the server round-trip
  // so the UI feels instant (same as iMessage / Instagram). The real server
  // response will replace this via nxAppendSentMessage moments later.
  const _optimisticTs = new Date().toISOString();
  const _optimisticMsg = {
    id: '__optimistic__', sender: sKey(), receiver: _dmPeer.key,
    text: finalText, ts: _optimisticTs, image_url: imgData||null,
  };
  const chatObjOpt = _cache.chatList.find(c=>c.peer.student_key===_dmPeer.key);
  if(chatObjOpt){
    // Temporarily push the optimistic message into the cache for rendering
    chatObjOpt.messages = [...(chatObjOpt.messages||[]), _optimisticMsg];
    nxRenderDMMessages(chatObjOpt.messages);
    // Remove the temporary entry so the real server message replaces it cleanly
    chatObjOpt.messages = chatObjOpt.messages.filter(m=>m.id!=='__optimistic__');
  } else {
    // No thread in cache yet — inject a one-off optimistic bubble directly into the DOM
    const box=$('dmMessages');
    if(box){
      const now=new Date(_optimisticTs);
      const hhmm=now.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
      box.insertAdjacentHTML('beforeend',
        `<div class="dm-bubble-row me" id="opt-bubble">
           <div class="dm-bubble me"><div class="dm-bubble-text">${esc(text)}</div>
           <div class="bubble-meta me"><div class="bubble-time">${hhmm}</div></div></div></div>`);
      box.scrollTop=box.scrollHeight;
    }
  }

  const res=await edgeCall(payload);
  if(res&&res.ok&&res.message){
    nxDMTyping();
    nxAppendSentMessage(_dmPeer.key, res.message);
  } else {
    $('dmSendBtn').disabled=false;
    // restore the typed text and image if it failed
    inp.value = text;
    if(imgData) {
       _dmPendingImage = imgData;
       $('dmImagePreview').src = _dmPendingImage;
       show('dmImagePreviewWrap');
    }
    const errMsg = res?.message||'Could not send DM';
    // Mutual follow restriction: show a professional modal instead of a plain toast
    if(errMsg && (errMsg.includes('follow each other') || errMsg.includes('mutual') || errMsg.includes('Follow them first'))){
      nxOpenNoMutualFollowModal(_dmPeer?_dmPeer.name:'');
    } else {
      showToast(errMsg,'err');
    }
  }
}

/**
 * Optimistically inserts a just-sent DM into the open thread and the chat list cache.
 * Fix: We normalize the message keys to exactly match what the frontend expects 
 * (`sender`, `receiver`, `ts`, `image_url`) so it knows we are the sender and
 * puts the message on the correct side immediately.
 */
function nxAppendSentMessage(peerKey, message){
  let chatObj=_cache.chatList.find(c=>c.peer.student_key===peerKey);
  if(!chatObj){
    // First message ever sent to this peer — no existing chat list entry yet.
    const peerProfile=_cache.profiles.get(peerKey)||{student_key:peerKey,student_name:_dmPeer?_dmPeer.name:'Student'};
    chatObj={peer:peerProfile,messages:[],latest:null};
    _cache.chatList.unshift(chatObj);
  }

  // Normalize mapping (backend returns sender_key/receiver_key directly after insert)
  const formattedMsg = {
    id: message.id,
    sender: message.sender_key || message.sender, // Handle both just in case
    receiver: message.receiver_key || message.receiver,
    text: message.is_deleted ? "" : (message.text || ""),
    image_url: message.image_url || null, // Capture image if returned
    ts: message.created_at || message.ts || new Date().toISOString(),
    is_edited: !!message.is_edited,
    is_deleted: !!message.is_deleted
  };

  // Avoid double-inserting if realtime ALSO delivers this same message.
  const alreadyPresent = formattedMsg.id!=null && chatObj.messages.some(m=>String(m.id)===String(formattedMsg.id));
  if(!alreadyPresent){
    chatObj.messages.push(formattedMsg);
    chatObj.latest=formattedMsg;
    _cache.chatList.sort((a,b)=>new Date(b.latest?.ts||0)-new Date(a.latest?.ts||0));
  }
  
  if($('dmScreen').style.display==='flex' && _dmPeer && _dmPeer.key===peerKey){
    nxRenderDMMessages(chatObj.messages);
  }
  if(_activeTab==='chats') nxRenderChatList();
}

function nxStartEditDM(msgId){
  const chatObj=_cache.chatList.find(c=>c.peer.student_key===_dmPeer.key);
  if(!chatObj) return;
  const m=chatObj.messages.find(x=>String(x.id)===String(msgId));
  if(!m) return;
  _dmEditingId=msgId;
  $('dmInput').value=m.text;
  nxRemoveDMImage();
  nxDMTyping();
  show('dmEditBanner');
  $('dmInput').focus();
}

function nxCancelEditDM(){
  _dmEditingId=null; hide('dmEditBanner'); $('dmInput').value=''; nxDMTyping();
}

/* ═══════════════════════════════════════════════════
   KEYBOARD / ESC
═══════════════════════════════════════════════════ */
// Close emoji reaction picker when tapping anywhere outside it
document.addEventListener('click',e=>{
  const picker=$('emojiPickerFloat');
  if(picker&&picker.style.display!=='none'&&!picker.contains(e.target)) nxHideEmojiPicker();
});
document.addEventListener('keydown',e=>{
  if(e.key!=='Escape') return;
  if($('mainMenuModal').style.display==='flex'){nxCloseMainMenu();return;}
  if($('blockListModal').style.display==='flex'){nxCloseBlockedUsers();return;}
  if($('myProfileScreen').style.display==='flex'){nxCloseMyProfile();return;}
  if($('followListModal').style.display==='flex'){nxCloseFollowList();return;}
  if($('editProfileModal').style.display==='flex'){nxCloseEditProfile();return;}
  if($('reportModal').style.display==='flex'){nxCloseReport();return;}
  if($('menuModal').style.display==='flex'){nxCloseMenu();return;}
  if($('clearChatModal').style.display==='flex'){nxCloseClearChatConfirm();return;}
  if($('dmOptionsModal').style.display==='flex'){nxCloseDMOptions();return;}
  if($('replyModal').style.display==='flex'){nxCloseReply();return;}
  if($('commentsModal').style.display==='flex'){nxCloseComments();return;}
  if($('composerModal').style.display==='flex'){nxCloseComposer();return;}
  if($('profileScreen').style.display==='flex'){nxCloseProfile();return;}
  if($('dmScreen').style.display==='flex'){nxCloseDM();return;}
  if($('searchScreen').style.display==='flex'){nxCloseSearchScreen();return;}
});

