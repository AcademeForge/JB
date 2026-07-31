(function(){
  'use strict';

  const STUDENT_URL = 'https://afooyyydhlwngzssgqih.supabase.co';
  const STUDENT_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFmb295eXlkaGx3bmd6c3NncWloIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg2NDQxMjgsImV4cCI6MjA5NDIyMDEyOH0.KG0XO0oP_2MpewHoIwTtbrKg5FkyOYRUtVzLH1MSJiE';
  const SUPABASE_SRC = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2';
  const $ = id => document.getElementById(id);

  let sbClient = null;
  let sbLoadPromise = null;

  function afIsLoggedIn(){
    return localStorage.getItem('af_student_logged_in') === 'true'
      || !!localStorage.getItem('af_student_email')
      || !!localStorage.getItem('af_student_mobile');
  }

  function enterGate(){
    document.body.classList.add('gate-active');
    const main = $('mainView');
    if(main) main.classList.add('hidden');
    showAuthView();
  }

  function enterApp(){
    document.body.classList.remove('gate-active');
    const main = $('mainView');
    if(main) main.classList.remove('hidden');
  }

  function showAuthView(){
    clearAuthMsg();
    const flow = $('authFlow');
    if(flow) flow.scrollTop = 0;
    setTimeout(()=>($('alLoginId') || {}).focus?.(), 80);
  }

  function showAuthMsg(type, text){
    const box = $('alMsg');
    if(!box) return;
    box.className = 'auth-msg ' + (type || '');
    box.textContent = text || '';
  }

  function clearAuthMsg(){
    const box = $('alMsg');
    if(!box) return;
    box.className = 'auth-msg';
    box.textContent = '';
  }

  function cleanPhone(value){
    return String(value || '').trim().replace(/\D/g, '');
  }

  function afGetDeviceId(){
    const key = 'af_device_id';
    let id = localStorage.getItem(key);
    if(!id){
      id = 'afdev_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 12);
      localStorage.setItem(key, id);
    }
    return id;
  }

  function afGetDeviceName(){
    const ua = navigator.userAgent || '';
    if(/Android/i.test(ua)) return 'Android WebView';
    if(/iPhone|iPad/i.test(ua)) return 'iOS WebView';
    if(/Windows/i.test(ua)) return 'Windows Browser';
    return 'Web Browser';
  }

  async function loadSupabase(){
    if(window.supabase) return;
    if(sbLoadPromise) return sbLoadPromise;
    sbLoadPromise = new Promise((resolve, reject)=>{
      const existing = document.querySelector('script[data-af-supabase]');
      if(existing){
        existing.addEventListener('load', resolve, {once:true});
        existing.addEventListener('error', reject, {once:true});
        return;
      }
      const script = document.createElement('script');
      script.src = SUPABASE_SRC;
      script.async = true;
      script.dataset.afSupabase = '1';
      script.onload = resolve;
      script.onerror = reject;
      document.head.appendChild(script);
    });
    return sbLoadPromise;
  }

  async function getSb(){
    if(sbClient) return sbClient;
    await loadSupabase();
    sbClient = window.supabase.createClient(STUDENT_URL, STUDENT_KEY);
    return sbClient;
  }

  function afSaveSession(student, token, deviceId){
    localStorage.setItem('af_student_logged_in', 'true');
    localStorage.setItem('af_session_token', token || '');
    localStorage.setItem('af_device_id', deviceId || afGetDeviceId());
    localStorage.setItem('af_student_uuid', student.id || '');
    localStorage.setItem('af_student_id', student.student_id || student.mobile || student.phone || '');
    localStorage.setItem('af_student_mobile', student.mobile || student.phone || '');
    localStorage.setItem('af_student_email', student.email || '');
    localStorage.setItem('af_student_name', student.name || 'Student');
    if(student.profile_icon || student.avatar){
      localStorage.setItem('af_student_avatar', student.profile_icon || student.avatar);
    }
  }

  async function doAcademeLogin(){
    const loginId = (($('alLoginId') || {}).value || '').trim();
    const password = (($('alPassword') || {}).value || '').trim();
    const cleanId = cleanPhone(loginId);
    if(!loginId){ showAuthMsg('err', 'Enter your Student ID or phone number.'); return; }
    if(!password){ showAuthMsg('err', 'Enter your password.'); return; }

    const btn = $('alLoginBtn');
    if(btn){ btn.disabled = true; btn.innerHTML = '<span>Signing in...</span>'; }
    showAuthMsg('info', 'Checking your login...');

    try{
      const sb = await getSb();
      const {data, error} = await sb.functions.invoke('student-login-af', {
        body: {
          login_id: loginId,
          clean_login_id: cleanId,
          password,
          device_id: afGetDeviceId(),
          device_name: afGetDeviceName()
        }
      });
      if(error){ showAuthMsg('err', error.message || 'Login failed.'); return; }
      if(!data || !data.ok){ showAuthMsg('err', (data && data.message) || 'Login failed.'); return; }
      if(!data.student){ showAuthMsg('err', 'Login failed. Student data not received.'); return; }

      const token = data.session_token || data.login_token || '';
      if(!token){ showAuthMsg('err', 'Login failed. Session token not received.'); return; }

      afSaveSession(data.student, token, data.device_id || afGetDeviceId());
      if(window.AFPush) window.AFPush.init(data.student.student_id || data.student.id, data.student.batch || 'All');
      showAuthMsg('ok', 'Login successful. Starting JB Knowledge Park...');
      enterApp();
      if(typeof window.init === 'function') setTimeout(()=>window.init(), 120);
    }catch(e){
      showAuthMsg('err', (e && e.message) || 'Something went wrong. Please try again.');
    }finally{
      if(btn){ btn.disabled = false; btn.innerHTML = '<span>Sign In to Community</span>'; }
    }
  }

  window.afAuth = {afIsLoggedIn, enterGate, enterApp, showAuthView};
  window.showAuthView = showAuthView;
  window.doAcademeLogin = doAcademeLogin;
})();
