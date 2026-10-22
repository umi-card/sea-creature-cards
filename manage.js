(() => {
  // ── 公開先（GitHub Pages の URL から判定） ──
  const host = location.hostname;
  const OWNER = host.endsWith('.github.io') ? host.split('.')[0] : 'umi-card';
  const REPO = host.endsWith('.github.io') ? (location.pathname.split('/')[1] || 'sea-creature-cards') : 'sea-creature-cards';
  const BRANCH = 'main';
  const SITE = host.endsWith('.github.io') ? `https://${host}/${REPO}/` : new URL('./', location.href).href;
  // 部員ページと管理者ページで同じコードを使う。<body data-mode="admin|member">
  const MODE = document.body.dataset.mode === 'admin' ? 'admin' : 'member';
  // 以前の共通ページのログイン情報（部員パスワードで入った端末にも残っている）は引き継がない
  const KEY_STORE = `seacards-v2-${MODE}-token`;
  const KID_STORE = `seacards-v2-${MODE}-kid`;
  try { localStorage.removeItem('seacards-admin-token'); localStorage.removeItem('seacards-admin-kid'); } catch (e) {}
  // パスワードで暗号化した鍵 { member, admin }（公開されるが、パスワードがないと読めない）
  const KEY_FILE = 'keys.json';
  const OLD_KEY_FILE = 'admin-key.json';   // 以前の形式（部員用だけ）
  const PBKDF2_ITER = 600000;
  const MIN_PW = 12;
  const API = 'https://api.github.com';
  const SCALE = 2;

  const $ = (id) => document.getElementById(id);

  let token = '';
  try { token = localStorage.getItem(KEY_STORE) || ''; } catch (e) {}

  // ── GitHub API ──
  async function gh(path, opts = {}) {
    const res = await fetch(API + path, {
      ...opts,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
      },
      cache: 'no-store',
    });
    if (res.status === 404 && opts.allow404) return null;
    if (!res.ok) {
      const err = new Error(`GitHub ${res.status}`);
      err.status = res.status;
      try { err.detail = (await res.json()).message; } catch (e) {}
      throw err;
    }
    return res.status === 204 ? null : res.json();
  }

  const repoPath = (p) => `/repos/${OWNER}/${REPO}${p}`;

  function bytesToBase64(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }
  const textToBase64 = (t) => bytesToBase64(new TextEncoder().encode(t));
  const base64ToText = (b) => new TextDecoder().decode(Uint8Array.from(atob(b.replace(/\s/g, '')), c => c.charCodeAt(0)));
  async function blobToBase64(blob) { return bytesToBase64(new Uint8Array(await blob.arrayBuffer())); }

  async function readIndex(ref) {
    const f = await gh(repoPath(`/contents/n/index.json?ref=${ref}`), { allow404: true });
    return f ? JSON.parse(base64ToText(f.content)) : [];
  }

  // buildFiles(index, head) → { files:[{path, base64|null}], message }。最新の main に対して 1 コミットで反映（競合したらやり直す）
  async function commit(buildFiles) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const ref = await gh(repoPath(`/git/ref/heads/${BRANCH}`));
      const head = ref.object.sha;
      const base = await gh(repoPath(`/git/commits/${head}`));
      const index = await readIndex(head);
      const { files, message } = await buildFiles(index, head);
      const tree = [];
      for (const f of files) {
        if (f.base64 == null) { tree.push({ path: f.path, mode: '100644', type: 'blob', sha: null }); continue; }
        const blob = await gh(repoPath('/git/blobs'), { method: 'POST', body: JSON.stringify({ content: f.base64, encoding: 'base64' }) });
        tree.push({ path: f.path, mode: '100644', type: 'blob', sha: blob.sha });
      }
      const newTree = await gh(repoPath('/git/trees'), { method: 'POST', body: JSON.stringify({ base_tree: base.tree.sha, tree }) });
      const newCommit = await gh(repoPath('/git/commits'), { method: 'POST', body: JSON.stringify({ message, tree: newTree.sha, parents: [head] }) });
      try {
        await gh(repoPath(`/git/refs/heads/${BRANCH}`), { method: 'PATCH', body: JSON.stringify({ sha: newCommit.sha }) });
        return;
      } catch (e) {
        if (e.status !== 422 || attempt === 2) throw e;   // 同時に別の更新が入った場合はやり直す
      }
    }
  }

  function explain(e) {
    if (e.status === 401) return '鍵が使えなくなっています（有効期限切れなど）。管理者が新しい鍵で設定しなおしてください。';
    if (e.status === 403 || e.status === 404) return 'この鍵には書き込みの権限がありません。public_repo にチェックを入れた鍵（または Contents を Read and write にした鍵）を発行してください。';
    if (e instanceof TypeError) return '通信できませんでした。電波の良いところでもう一度お試しください。';
    return `エラーが起きました（${e.message}${e.detail ? '：' + e.detail : ''}）`;
  }

  function status(el, kind, html) {
    el.className = `status show ${kind}`;
    el.innerHTML = html;
  }

  // ── 鍵の暗号化（パスワード → PBKDF2 → AES-GCM） ──
  const b64 = (u8) => bytesToBase64(u8);
  const unb64 = (t) => Uint8Array.from(atob(t), c => c.charCodeAt(0));

  async function pwKey(pw, salt, iter) {
    const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: iter, hash: 'SHA-256' },
      base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }

  async function sealToken(tok, pw) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await pwKey(pw, salt, PBKDF2_ITER);
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(tok)));
    const kid = b64(crypto.getRandomValues(new Uint8Array(9)));
    return { v: 1, kid, iter: PBKDF2_ITER, salt: b64(salt), iv: b64(iv), ct: b64(ct) };
  }

  async function openToken(sealed, pw) {
    const key = await pwKey(pw, unb64(sealed.salt), sealed.iter);
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(sealed.iv) }, key, unb64(sealed.ct));
    return new TextDecoder().decode(pt);
  }

  // 公開サイトから暗号化された鍵を読む → { member?, admin? }。通信できない時は undefined
  async function fetchKeys() {
    try {
      const get = async (f) => {
        const r = await fetch(`${SITE}${f}?t=${Date.now()}`, { cache: 'no-store' });
        if (r.status === 404) return null;
        if (!r.ok) throw new TypeError('fetch failed');
        return r.json();
      };
      const keys = await get(KEY_FILE);
      if (keys) return keys;
      const old = await get(OLD_KEY_FILE);
      return old ? { member: old } : {};
    } catch (e) {
      return undefined;
    }
  }

  async function checkKey() {
    const repo = await gh(repoPath(''));
    if (!repo.permissions || !repo.permissions.push) {
      const e = new Error('no push'); e.status = 403; throw e;
    }
  }

  function remember(tok, kid) {
    token = tok;
    try { localStorage.setItem(KEY_STORE, tok); localStorage.setItem(KID_STORE, kid); } catch (e) {}
  }
  function forget() {
    token = '';
    try { localStorage.removeItem(KEY_STORE); localStorage.removeItem(KID_STORE); } catch (e) {}
  }

  function checkNewPw(a, b) {
    if (a.length < MIN_PW) return `パスワードは${MIN_PW}文字以上にしてください。`;
    if (a !== b) return '確認用のパスワードが一致しません。';
    return '';
  }

  async function readRepoJson(path, ref) {
    const f = await gh(repoPath(`/contents/${path}?ref=${ref}`), { allow404: true });
    return f ? JSON.parse(base64ToText(f.content)) : null;
  }

  // keys.json の一部（member / admin）を差しかえて保存。サイトへの反映は1〜2分後
  async function saveKeys(changes, message) {
    await commit(async (index, head) => {
      const cur = await readRepoJson(KEY_FILE, head);
      const old = cur ? null : await readRepoJson(OLD_KEY_FILE, head);
      const keys = { v: 2, ...(cur || (old ? { member: old } : {})), ...changes };
      const files = [{ path: KEY_FILE, base64: textToBase64(JSON.stringify(keys)) }];
      if (old) files.push({ path: OLD_KEY_FILE, base64: null });   // 以前の形式は消す
      return { message, files };
    });
  }

  // ── ログイン（部員ページは部員用、管理者ページは管理者用のパスワード） ──
  async function login() {
    const pw = $('login-pw').value;
    if (!pw) return;
    const btn = $('login-btn');
    btn.disabled = true;
    status($('login-status'), 'warn', '確認しています…');
    try {
      const keys = await fetchKeys();
      if (keys === undefined) throw new TypeError('offline');
      const sealed = keys[MODE];
      if (!sealed) return status($('login-status'), 'err', 'まだ管理者がパスワードを設定していません。');
      let tok;
      try { tok = await openToken(sealed, pw); }
      catch (e) { return status($('login-status'), 'err', 'パスワードがちがいます。'); }
      token = tok;
      await checkKey();
      remember(tok, sealed.kid);
      $('login-pw').value = '';
      $('login-status').className = 'status';
      showEditor();
    } catch (e) {
      token = '';
      status($('login-status'), 'err', explain(e));
    } finally {
      btn.disabled = false;
    }
  }
  $('login-btn').addEventListener('click', login);
  $('login-pw').addEventListener('keydown', (e) => { if (e.key === 'Enter') login(); });

  $('forget-key').addEventListener('click', () => {
    if (!confirm('この端末からログアウトしますか？')) return;
    forget();
    showLogin();
  });

  // ── 管理者だけの操作 ──
  if (MODE === 'admin') {
    // 初期設定・鍵の更新（GitHub の鍵＋管理者パスワード＋部員用パスワード）
    $('save-key').addEventListener('click', async () => {
      const t = $('token').value.trim();
      const apw = $('admin-pw').value, apw2 = $('admin-pw2').value;
      const mpw = $('member-pw').value, mpw2 = $('member-pw2').value;
      if (!t) return status($('key-status'), 'err', 'GitHub の鍵を貼りつけてください。');
      let bad = checkNewPw(apw, apw2);
      if (bad) return status($('key-status'), 'err', '管理者パスワード：' + bad);
      const keys = await fetchKeys();
      const needMember = !(keys && keys.member);
      if (mpw || mpw2 || needMember) {
        bad = checkNewPw(mpw, mpw2);
        if (bad) return status($('key-status'), 'err', '部員用パスワード：' + bad);
        if (mpw === apw) return status($('key-status'), 'err', '管理者パスワードと部員用パスワードは、別のものにしてください。');
      }
      const btn = $('save-key');
      btn.disabled = true;
      token = t;
      status($('key-status'), 'warn', '鍵を確認しています…');
      try {
        await checkKey();
        status($('key-status'), 'warn', '暗号化して保存しています…');
        const changes = { admin: await sealToken(t, apw) };
        if (mpw) changes.member = await sealToken(t, mpw);
        await saveKeys(changes, '管理者の設定を更新');
        remember(t, changes.admin.kid);
        ['token', 'admin-pw', 'admin-pw2', 'member-pw', 'member-pw2'].forEach(id => $(id).value = '');
        $('key-status').className = 'status';
        showEditor();
        alert('設定しました（サイトへの反映まで1〜2分かかります）。');
      } catch (e) {
        token = '';
        status($('key-status'), 'err', explain(e));
      } finally {
        btn.disabled = false;
      }
    });

    // パスワード変更（ログイン中の鍵で暗号化しなおす）
    const changePw = (who) => async () => {
      const pw = $(`chg-${who}-pw`).value, pw2 = $(`chg-${who}-pw2`).value;
      const st = $(`chg-${who}-status`);
      const bad = checkNewPw(pw, pw2);
      if (bad) return status(st, 'err', bad);
      const label = who === 'member' ? '部員用パスワード' : '管理者パスワード';
      const note = who === 'member' ? '\nログイン中の部員は全員、新しいパスワードで入りなおしになります。' : '\nほかの端末の管理者ページも入りなおしになります。';
      if (!confirm(`${label}を変更しますか？${note}`)) return;
      const btn = $(`chg-${who}-btn`);
      btn.disabled = true;
      status(st, 'warn', '保存しています…');
      try {
        const sealed = await sealToken(token, pw);
        await saveKeys({ [who]: sealed }, `${label}を変更`);
        if (who === 'admin') { remember(token, sealed.kid); $('admin-pw-needed').classList.add('hidden'); }
        [`chg-${who}-pw`, `chg-${who}-pw2`].forEach(id => $(id).value = '');
        status(st, 'ok', '変更しました。1〜2分後から新しいパスワードが使えます。');
      } catch (e) {
        status(st, 'err', explain(e));
      } finally {
        btn.disabled = false;
      }
    };
    $('chg-member-btn').addEventListener('click', changePw('member'));
    $('chg-admin-btn').addEventListener('click', changePw('admin'));

    $('back-to-login').addEventListener('click', showLogin);
    $('open-setup').addEventListener('click', (e) => { e.preventDefault(); showSetup(); });
  }

  const PANELS = ['login', 'key-setup', 'editor', 'list-section', 'search-section', 'key-info'];
  function showOnly(ids) {
    PANELS.forEach(id => { const el = $(id); if (el) el.classList.toggle('hidden', !ids.includes(id)); });
  }
  function showLogin() { showOnly(['login']); }
  function showSetup() { showOnly(['key-setup']); }

  function showEditor() {
    showOnly(['editor', 'list-section', 'key-info']);
    draw();
    loadList();
    loadSearchLink();
  }

  // 検索ページのファイル名は推測されにくい名前（s-xxxx.html）。管理者の鍵で一覧を見て探す
  let searchUrl = null;
  async function loadSearchLink() {
    try {
      const ref = await gh(repoPath(`/git/ref/heads/${BRANCH}`));
      const commitObj = await gh(repoPath(`/git/commits/${ref.object.sha}`));
      const tree = await gh(repoPath(`/git/trees/${commitObj.tree.sha}`));
      const f = tree.tree.find(e => /^s-[a-z0-9]{8,}\.html$/.test(e.path));
      if (!f) return;
      searchUrl = SITE + f.path;
      $('search-link').href = searchUrl;
      $('search-link').textContent = searchUrl;
      $('search-qr').src = qrCanvas(searchUrl).toDataURL('image/png');
      $('search-section').classList.remove('hidden');
    } catch (e) {}
  }
  $('search-qr-dl').addEventListener('click', () => searchUrl && saveQr('検索ページ', searchUrl));

  // ── カードの編集 ──
  const canvas = $('canvas');
  const ctx = canvas.getContext('2d');
  canvas.width = CardRender.W * SCALE;
  canvas.height = CardRender.H * SCALE;
  const state = { photo: null, layout: 'portrait', view: { zoom: 1, ox: 0, oy: 0 } };

  function cardData() {
    return { name: $('name').value, sci: $('sci').value, feature: $('feature').value, photo: state.photo, layout: state.layout, view: state.view };
  }

  let lines = null;
  // forImage=true は公開用の画像（和名が空でも「（和名）」の見本文字を入れない）
  function draw(forImage = false) {
    ctx.setTransform(SCALE, 0, 0, SCALE, 0, 0);
    const r = CardRender.render(ctx, { ...cardData(), preview: !forImage });
    lines = r;
    $('overflow-note').textContent = r.overflow ? '⚠ 特徴の文が長すぎて、はみ出しています。短くしてください。' : '';
  }

  let fontTimer;
  async function redraw() {
    draw();
    clearTimeout(fontTimer);
    fontTimer = setTimeout(async () => {
      await CardRender.ensureFonts($('name').value + $('feature').value);
      draw();
    }, 150);
  }

  ['name', 'sci', 'feature'].forEach(id => $(id).addEventListener('input', redraw));

  function setLayout(layout) {
    state.layout = layout;
    document.querySelectorAll('.seg button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.layout === layout)));
    state.view = { zoom: 1, ox: 0, oy: 0 };
    $('zoom').value = 1;
    redraw();
  }
  document.querySelectorAll('.seg button').forEach(b => b.addEventListener('click', () => setLayout(b.dataset.layout)));

  $('zoom').addEventListener('input', (e) => { state.view.zoom = +e.target.value; redraw(); });

  $('photo').addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      state.photo = img;
      setLayout(img.naturalWidth > img.naturalHeight * 1.3 ? 'landscape' : 'portrait');
    };
    img.onerror = () => alert('この写真は読みこめませんでした。別の写真をえらんでください。');
    img.src = url;
  });

  // 写真の位置をドラッグで調整
  let drag = null;
  canvas.addEventListener('pointerdown', (e) => {
    if (!state.photo) return;
    const rect = canvas.getBoundingClientRect();
    const k = CardRender.W / rect.width;
    const x = (e.clientX - rect.left) * k, y = (e.clientY - rect.top) * k;
    const p = CardRender.LAYOUTS[state.layout].photo;
    if (x < p.x || x > p.x + p.w || y < p.y || y > p.y + p.h) return;
    const img = state.photo;
    const s = Math.max(p.w / img.naturalWidth, p.h / img.naturalHeight) * state.view.zoom;
    drag = { id: e.pointerId, sx: e.clientX, sy: e.clientY, ox: state.view.ox, oy: state.view.oy, k,
             spareX: img.naturalWidth * s - p.w, spareY: img.naturalHeight * s - p.h };
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = (e.clientX - drag.sx) * drag.k, dy = (e.clientY - drag.sy) * drag.k;
    const clamp = (v) => Math.max(-1, Math.min(1, v));
    if (drag.spareX > 0) state.view.ox = clamp(drag.ox + dx / (drag.spareX / 2));
    if (drag.spareY > 0) state.view.oy = clamp(drag.oy + dy / (drag.spareY / 2));
    draw();
  });
  const endDrag = () => { drag = null; };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);

  // ── 公開 ──
  const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
  function newId() {
    const a = crypto.getRandomValues(new Uint8Array(8));
    return Array.from(a, v => ALPHABET[v % ALPHABET.length]).join('');
  }

  $('publish').addEventListener('click', async () => {
    const name = $('name').value.trim(), sci = $('sci').value.trim(), feature = $('feature').value.trim();
    const pub = $('pub-status');
    // 和名・学名はなくてもよい（種がわからない生きもの用）
    const missing = [!state.photo && '写真', !feature && '特徴'].filter(Boolean);
    if (missing.length) return status(pub, 'err', `${missing.join('・')}を入れてください。`);
    const label = cardLabel({ name, sci });
    if (!confirm(`「${label}」のカードを公開しますか？${name ? '' : '\n（和名なしのカードになります）'}\n公開すると、だれでも見られるようになります。`)) return;

    const btn = $('publish');
    btn.disabled = true;
    status(pub, 'warn', '画像をつくっています…');
    try {
      await CardRender.ensureFonts(name + feature);
      draw(true);
      const jpg = await new Promise(ok => canvas.toBlob(ok, 'image/jpeg', 0.9));
      draw();
      const imageB64 = await blobToBase64(jpg);
      const id = newId();
      const created = new Date().toISOString();
      const card = {
        name, sci, feature, layout: state.layout, created,
        image: `${id}.jpg`, w: CardRender.W, h: CardRender.H,
        date: lines.date, finder: lines.finder,
      };
      status(pub, 'warn', 'サーバーに保存しています…');
      await commit(async (index) => ({
        message: `カード追加: ${label}`,
        files: [
          { path: `n/${id}.jpg`, base64: imageB64 },
          { path: `n/${id}.json`, base64: textToBase64(JSON.stringify(card)) },
          { path: 'n/index.json', base64: textToBase64(JSON.stringify([...index, { id, name, sci, created }], null, 1)) },
        ],
      }));
      const url = `${SITE}index.html?n=${id}`;
      showDone(label, url);
      status(pub, 'ok', '保存しました。');
      loadList();
      waitLive(id).then(ok => {
        status($('done-status'), ok ? 'ok' : 'warn', ok
          ? '✅ 公開されました！ このQRコードから開けます。'
          : '保存はできています。反映に時間がかかっているので、少し待ってからQRを読みこんでください。');
        if (ok) status(pub, 'ok', '✅ 公開されました。');
      });
    } catch (e) {
      status(pub, 'err', explain(e));
    } finally {
      btn.disabled = false;
    }
  });

  async function waitLive(id) {
    for (let i = 0; i < 36; i++) {
      await new Promise(r => setTimeout(r, 5000));
      try {
        const r = await fetch(`${SITE}n/${id}.json?t=${Date.now()}`, { cache: 'no-store' });
        if (r.ok) return true;
      } catch (e) {}
    }
    return false;
  }

  // ── QRコード ──
  function qrCanvas(url) {
    const qr = qrcode(0, 'M');
    qr.addData(url);
    qr.make();
    const n = qr.getModuleCount(), cell = 20, border = 4;
    const c = document.createElement('canvas');
    c.width = c.height = (n + border * 2) * cell;
    const g = c.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
    g.fillStyle = '#000';
    for (let r = 0; r < n; r++) for (let col = 0; col < n; col++) {
      if (qr.isDark(r, col)) g.fillRect((col + border) * cell, (r + border) * cell, cell, cell);
    }
    return c;
  }

  async function saveQr(name, url) {
    const blob = await new Promise(ok => qrCanvas(url).toBlob(ok, 'image/png'));
    const file = new File([blob], `QR_${name || 'カード'}.png`, { type: 'image/png' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file] }); return; } catch (e) { if (e.name === 'AbortError') return; }
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = file.name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  }

  // 公開したらすぐ、QRコードを画面の真ん中に出す
  let doneInfo = null;
  function showDone(label, url) {
    doneInfo = { name: label, url };
    $('done-title').textContent = `「${label}」のQRコード`;
    $('done-qr').src = qrCanvas(url).toDataURL('image/png');
    $('done-link').href = url;
    $('done-link').textContent = url;
    status($('done-status'), 'warn', '⏳ サイトに反映中です（1〜2分）。反映されるとこのQRで開けるようになります。');
    $('done').classList.remove('hidden');
    document.body.classList.add('modal-open');
  }
  function closeDone() {
    $('done').classList.add('hidden');
    document.body.classList.remove('modal-open');
  }
  $('done-qr-dl').addEventListener('click', () => doneInfo && saveQr(doneInfo.name, doneInfo.url));
  $('done-close').addEventListener('click', closeDone);
  $('new-card').addEventListener('click', () => {
    ['name', 'sci', 'feature'].forEach(id => $(id).value = '');
    $('photo').value = '';
    state.photo = null;
    closeDone();
    $('pub-status').className = 'status';
    setLayout('portrait');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });

  // 一覧などに出す名前（和名 → 学名 → 「名前なし」）
  function cardLabel(c) {
    return (c.name || '').trim() || (c.sci || '').trim() || '名前なしのカード';
  }

  // ── 登録済み一覧 ──
  async function loadList() {
    const ul = $('list');
    try {
      const ref = await gh(repoPath(`/git/ref/heads/${BRANCH}`));
      const index = await readIndex(ref.object.sha);
      ul.replaceChildren();
      $('list-empty').classList.toggle('hidden', index.length > 0);
      for (const c of [...index].reverse()) {
        const url = `${SITE}index.html?n=${c.id}`;
        const li = document.createElement('li');
        const t = document.createElement('div');
        t.innerHTML = '<div class="title"></div><div class="sci"></div><div class="meta"></div>';
        t.querySelector('.title').textContent = cardLabel(c);
        t.querySelector('.sci').textContent = c.sci || '';
        t.querySelector('.meta').textContent = new Date(c.created).toLocaleString('ja-JP') + ' に追加';
        const row = document.createElement('div');
        row.className = 'row';
        const open = document.createElement('a');
        open.className = 'btn sub small'; open.href = url; open.target = '_blank'; open.rel = 'noopener'; open.textContent = '開く';
        const qrBtn = document.createElement('button');
        qrBtn.className = 'sub small'; qrBtn.textContent = 'QRを保存';
        qrBtn.onclick = () => saveQr(cardLabel(c), url);
        const del = document.createElement('button');
        del.className = 'danger small'; del.textContent = '削除';
        del.onclick = () => removeCard(c, del);
        row.append(open, qrBtn, del);
        li.append(t, row);
        ul.append(li);
      }
    } catch (e) {
      $('list-empty').classList.remove('hidden');
      $('list-empty').textContent = explain(e);
    }
  }

  async function removeCard(c, btn) {
    if (!confirm(`「${cardLabel(c)}」のカードを削除しますか？\nこのカードのQRコードは使えなくなります。`)) return;
    btn.disabled = true;
    try {
      await commit(async (index) => ({
        message: `カード削除: ${cardLabel(c)}`,
        files: [
          { path: `n/${c.id}.jpg`, base64: null },
          { path: `n/${c.id}.json`, base64: null },
          { path: 'n/index.json', base64: textToBase64(JSON.stringify(index.filter(x => x.id !== c.id), null, 1)) },
        ],
      }));
      loadList();
    } catch (e) {
      btn.disabled = false;
      alert(explain(e));
    }
  }

  // ── 起動 ──
  CardRender.ensureFonts().then(draw);
  (async () => {
    const keys = await fetchKeys();
    const sealed = keys && keys[MODE];
    let kid = '';
    try { kid = localStorage.getItem(KID_STORE) || ''; } catch (e) {}
    if (token) {
      // 通信できない時はそのまま。パスワードが変更されていたら入りなおし
      if (keys === undefined || (sealed && sealed.kid === kid)) return showEditor();
      // 管理者パスワードをまだ決めていない管理者（以前のページで鍵を登録済み）
      if (MODE === 'admin' && !sealed) { showEditor(); $('admin-pw-needed').classList.remove('hidden'); return; }
      forget();
    }
    if (MODE === 'admin' && keys && !keys.admin) return showSetup();
    showLogin();
  })();
})();
