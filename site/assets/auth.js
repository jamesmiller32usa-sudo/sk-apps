// Two-step sign-in for Our Apps.
// 1. Gate: one shared team password opens the site and shows every app.
// 2. Each app has its own login (CRM: personal accounts in Supabase; Books: its own built-in sign-in).
// Two separate Supabase clients keep the gate session and the CRM session apart.
// Requires @supabase/supabase-js v2 (UMD) loaded before this file.
(function () {
  var SUPA_URL = 'https://dkwlsfzysjdubcwuemvx.supabase.co';
  var SUPA_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRrd2xzZnp5c2pkdWJjd3VlbXZ4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc5OTgxNzQsImV4cCI6MjA5MzU3NDE3NH0.SAf7NDNbtrOFW8JDM_WDJ8Dbz_bCdzMJDV6RLp_pCUA';
  var EMAIL_DOMAIN = 'skhq.app';
  var GATE_EMAIL = 'team@' + EMAIL_DOMAIN;
  function client(key) {
    return window.supabase.createClient(SUPA_URL, SUPA_ANON, { auth: { persistSession: true, autoRefreshToken: true, storageKey: key } });
  }
  var gate = client('ourapps-gate');
  var crm = client('ourapps-crm');

  function emailFor(username) {
    username = String(username || '').trim().toLowerCase();
    return username.indexOf('@') > -1 ? username : username + '@' + EMAIL_DOMAIN;
  }

  // gate
  async function gateOk() {
    var s = (await gate.auth.getSession()).data.session;
    return !!(s && s.user && s.user.email === GATE_EMAIL);
  }
  async function gateSignIn(password) {
    var r = await gate.auth.signInWithPassword({ email: GATE_EMAIL, password: password });
    if (r.error) throw r.error;
    return true;
  }
  async function requireGate() {
    var ok = false;
    try { ok = await gateOk(); } catch (e) { console.error(e); }
    if (!ok) { location.replace('/?next=' + encodeURIComponent(location.pathname + location.hash)); return false; }
    return true;
  }
  async function signOutAll() {
    try { await crm.auth.signOut(); } catch (e) {}
    try { await gate.auth.signOut(); } catch (e) {}
    location.replace('/');
  }

  // CRM personal accounts
  async function crmProfile() {
    var s = (await crm.auth.getSession()).data.session;
    if (!s) return null;
    var r = await crm.from('app_users').select('*').eq('user_id', s.user.id).maybeSingle();
    if (!r.data || !r.data.active || !r.data.crm_role) return null;
    return Object.assign({}, r.data, { token: s.access_token });
  }
  async function crmSignIn(username, password) {
    var r = await crm.auth.signInWithPassword({ email: emailFor(username), password: password });
    if (r.error) throw r.error;
    var p = await crmProfile();
    if (!p) { await crm.auth.signOut(); throw new Error('This account has no CRM access.'); }
    return p;
  }
  async function crmSignOut() { try { await crm.auth.signOut(); } catch (e) {} }
  async function crmTeam() {
    var r = await crm.from('app_users').select('username, display_name, crm_role, active').eq('active', true).not('crm_role', 'is', null).order('username');
    return r.data || [];
  }

  window.SKAUTH = {
    gate: gate, crm: crm, SUPA_URL: SUPA_URL,
    gateOk: gateOk, gateSignIn: gateSignIn, requireGate: requireGate, signOutAll: signOutAll,
    crmProfile: crmProfile, crmSignIn: crmSignIn, crmSignOut: crmSignOut, crmTeam: crmTeam
  };
})();
