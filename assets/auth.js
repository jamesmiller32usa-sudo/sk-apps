// Shared sign-in for every app on this site (one origin = one session for all apps).
// Requires @supabase/supabase-js v2 (UMD) loaded before this file.
(function () {
  var SUPA_URL = 'https://dkwlsfzysjdubcwuemvx.supabase.co';
  var SUPA_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRrd2xzZnp5c2pkdWJjd3VlbXZ4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc5OTgxNzQsImV4cCI6MjA5MzU3NDE3NH0.SAf7NDNbtrOFW8JDM_WDJ8Dbz_bCdzMJDV6RLp_pCUA';
  var EMAIL_DOMAIN = 'skhq.app';
  var sb = window.supabase.createClient(SUPA_URL, SUPA_ANON, {
    auth: { persistSession: true, autoRefreshToken: true, storageKey: 'sk-auth' }
  });

  function emailFor(username) {
    username = String(username || '').trim().toLowerCase();
    return username.indexOf('@') > -1 ? username : username + '@' + EMAIL_DOMAIN;
  }

  async function profile() {
    var s = (await sb.auth.getSession()).data.session;
    if (!s) return null;
    var r = await sb.from('app_users').select('*').eq('user_id', s.user.id).maybeSingle();
    if (!r.data || !r.data.active) return null;
    return Object.assign({}, r.data, { token: s.access_token });
  }

  function canUse(p, app) {
    if (!p) return false;
    if (app === 'crm') return !!p.crm_role;
    if (app === 'books') return !!p.books;
    return false;
  }

  // Call at the top of an app. Sends the user to the portal if they are not signed in or not allowed.
  async function requireApp(app) {
    var p = null;
    try { p = await profile(); } catch (e) { console.error(e); }
    if (!canUse(p, app)) {
      location.replace('/?next=' + encodeURIComponent(location.pathname + location.hash));
      return null;
    }
    return p;
  }

  async function signIn(username, password) {
    var r = await sb.auth.signInWithPassword({ email: emailFor(username), password: password });
    if (r.error) throw r.error;
    return profile();
  }

  async function signOut() {
    try { await sb.auth.signOut(); } catch (e) {}
    location.replace('/');
  }

  async function team() {
    var r = await sb.from('app_users').select('username, display_name, crm_role, books, active').eq('active', true).order('username');
    return r.data || [];
  }

  window.SKAUTH = { sb: sb, profile: profile, canUse: canUse, requireApp: requireApp, signIn: signIn, signOut: signOut, team: team, SUPA_URL: SUPA_URL };
})();
