// 名刺管理 フロントエンド（外部ライブラリなし。データはブラウザに永続保存しない）
import { runOcr, parseCardText, OcrCandidates } from './ocr.js';

// ---------------- 型 ----------------
const CATS: [string, string][] = [['customer', '顧客'], ['prospect', '見込み客'], ['supplier', '仕入先'], ['partner', '協力会社'], ['other', 'その他']];
const CAT_LABEL: Record<string, string> = Object.fromEntries(CATS);
const TEXT = ['company', 'department', 'title', 'name', 'kana', 'phone', 'mobile', 'email', 'postalCode', 'address', 'website', 'exchangeDate', 'place', 'event', 'memo'] as const;
type TextKey = (typeof TEXT)[number];
interface Fields extends Record<TextKey, string> { category: string; tags: string[]; frontImage: string | null; backImage: string | null }
interface Card extends Fields { id: string; version: number; createdAt: string; updatedAt: string; createdByName?: string; updatedByName?: string }
interface Summary { id: string; version: number; company: string; department: string; title: string; name: string; kana: string; exchangeDate: string; event: string; category: string; tags: string[]; createdAt: string; hasImage: boolean }
interface User { id: string; name: string; role: 'admin' | 'member' }
interface Status { storage: { available: boolean; error: string; dataDir: string; backupDir: string }; inbox: { enabled: boolean; dir?: string; error?: string }; ocrAvailable: boolean; secure: boolean; user: User }
interface InboxItem { id: string; name: string; size: number; mtime: string; type: string; claimedBy?: string }

const LABELS: Record<string, string> = {
  company: '会社名', department: '部署', title: '役職', name: '氏名', kana: 'ふりがな', phone: '電話番号', mobile: '携帯番号', email: 'メールアドレス',
  postalCode: '郵便番号', address: '住所', website: 'Webサイト', exchangeDate: '名刺交換日', place: '会った場所', event: 'イベント名', memo: 'メモ',
  category: '分類', tags: 'タグ', frontImage: '画像（表）', backImage: '画像（裏）',
};

// ---------------- 小道具 ----------------
type Child = Node | string | null | undefined | false;
function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, unknown> = {}, ...kids: (Child | Child[])[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v as EventListener);
    else if (k === 'class') el.className = String(v);
    else if (k in el && typeof v !== 'string') (el as unknown as Record<string, unknown>)[k] = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of kids.flat()) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}
const $app = () => document.getElementById('app')!;
function mount(...nodes: Node[]): void { $app().replaceChildren(...nodes); window.scrollTo(0, 0); }
function toast(msg: string): void {
  const t = document.getElementById('toast')!;
  t.textContent = msg; t.hidden = false;
  clearTimeout((toast as unknown as { t?: number }).t);
  (toast as unknown as { t?: number }).t = window.setTimeout(() => { t.hidden = true; }, 2600);
}
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const fmtDate = (s: string) => (s ? s.replaceAll('-', '/') : '');
const dispName = (c: { company: string; name: string }) => c.name || '（氏名なし）';

// ---------------- API ----------------
class ApiError extends Error {
  constructor(readonly status: number, message: string, readonly body: Record<string, unknown> = {}) { super(message); }
}
async function api<T>(method: string, path: string, body?: unknown, raw?: Blob): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method, credentials: 'same-origin', cache: 'no-store',
      headers: { 'X-Meishi-Request': '1', ...(raw ? { 'Content-Type': raw.type || 'application/octet-stream' } : body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
    });
  } catch {
    setBanner('サーバーに接続できません。社内ネットワーク（Wi-Fi / VPN）への接続と、サーバーPCが起動しているかを確認してください。');
    throw new ApiError(0, 'サーバーに接続できません。通信状態を確認してください。');
  }
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (res.status === 401 && !path.startsWith('/api/login')) { location.hash = '#/login'; throw new ApiError(401, 'ログインしてください。'); }
  if (!res.ok) throw new ApiError(res.status, String(data.error ?? `エラー (${res.status})`), data);
  return data as T;
}

// ---------------- 状態表示 ----------------
let status: Status | null = null;
function setBanner(msg: string, warn = false): void {
  const b = document.getElementById('banner')!;
  b.textContent = msg; b.hidden = !msg; b.classList.toggle('warn', warn);
}
async function refreshStatus(): Promise<void> {
  if (location.hash === '#/login') return;
  try {
    status = await api<Status>('GET', '/api/status');
    setBanner(status.storage.available ? '' : `保存先（共有フォルダ）に接続できません。保存はできません。表示中の内容は最後に読み込んだものです。${status.storage.error ? '（' + status.storage.error + '）' : ''}`);
    for (const el of document.querySelectorAll<HTMLElement>('[data-inbox]')) el.hidden = !status.inbox.enabled;
    if (status.inbox.enabled) void api<{ items: InboxItem[] }>('GET', '/api/inbox').then((r) => {
      for (const el of document.querySelectorAll<HTMLElement>('[data-inbox-count]')) { el.textContent = r.items.length ? String(r.items.length) : ''; el.hidden = !r.items.length; }
    }).catch(() => undefined);
  } catch { /* api() がバナーを出す */ }
}
setInterval(() => void refreshStatus(), 30_000);

// ---------------- 未保存の確認 ----------------
let dirtyGuard: (() => boolean) | null = null;
window.addEventListener('beforeunload', (e) => { if (dirtyGuard?.()) { e.preventDefault(); e.returnValue = ''; } });

// ---------------- ルーター ----------------
let lastHash = location.hash;
async function route(): Promise<void> {
  if (dirtyGuard?.() && !confirm('保存していない入力内容があります。破棄して移動しますか？')) { history.replaceState(null, '', lastHash || '#/'); return; }
  dirtyGuard = null;
  lastHash = location.hash;
  const hash = location.hash || '#/';
  const authed = hash !== '#/login';
  document.getElementById('topnav')!.hidden = !authed;
  document.getElementById('bottombar')!.hidden = !authed;
  try {
    let m: RegExpExecArray | null;
    if (hash === '#/login') return viewLogin();
    if (!status) await refreshStatus();
    if (hash === '#/new' || hash.startsWith('#/new?')) {
      const ids = new URLSearchParams(hash.split('?')[1] ?? '').get('inbox')?.split(',').filter((x) => /^[0-9a-f]{32}$/.test(x)).slice(0, 2) ?? [];
      return await viewEdit(null, ids);
    }
    if (hash === '#/inbox') return await viewInbox();
    if ((m = /^#\/card\/([0-9a-f]{32})\/edit$/.exec(hash))) return await viewEdit(m[1]!);
    if ((m = /^#\/card\/([0-9a-f]{32})$/.exec(hash))) return await viewDetail(m[1]!);
    if (hash === '#/admin') return await viewAdmin();
    return await viewList();
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) return;
    mount(h('div', { class: 'error-box' }, h('strong', {}, '読み込めませんでした'), h('p', {}, (e as Error).message),
      h('button', { class: 'btn', onclick: () => void route() }, '再試行')));
  }
}
window.addEventListener('hashchange', () => void route());
document.addEventListener('click', (e) => {
  const a = (e.target as Element).closest('[data-action=search]');
  if (a) setTimeout(() => (document.getElementById('q') as HTMLInputElement | null)?.focus(), 50);
});

// ---------------- ログイン ----------------
async function viewLogin(): Promise<void> {
  const s = await api<{ authenticated: boolean; configured: boolean }>('GET', '/api/session').catch(() => null);
  if (s?.authenticated) { location.hash = '#/'; return; }
  const uid = h('input', { type: 'text', id: 'uid', autocomplete: 'username', autocapitalize: 'off', spellcheck: false, required: true });
  const pw = h('input', { type: 'password', id: 'pw', autocomplete: 'current-password', required: true });
  const err = h('div', { class: 'error-box', hidden: true });
  const btn = h('button', { class: 'btn btn-primary', type: 'submit' }, 'ログイン');
  const form = h('form', { class: 'panel login', onsubmit: async (e: Event) => {
    e.preventDefault(); btn.disabled = true; err.hidden = true;
    try {
      await api('POST', '/api/login', { userId: uid.value, password: pw.value });
      status = null; location.hash = '#/';
    } catch (x) { err.textContent = (x as Error).message; err.hidden = false; }
    finally { btn.disabled = false; }
  } },
  h('h1', {}, 'ログイン'),
  s && !s.configured ? h('div', { class: 'warn-box' }, '利用者が未登録です。サーバーPCで利用者を追加してください（導入手順書を参照）。') : null,
  err,
  h('label', { class: 'field' }, h('span', {}, 'ログインID'), uid),
  h('label', { class: 'field' }, h('span', {}, 'パスワード'), pw),
  btn,
  h('p', { class: 'small muted' }, 'このアプリは社内ネットワーク専用です。'));
  mount(form);
  uid.focus();
}

// ---------------- 一覧・検索 ----------------
const listState = { q: '', category: '', event: '', tag: '', sort: 'created' };
async function viewList(): Promise<void> {
  const q = h('input', { type: 'search', id: 'q', placeholder: '会社名・氏名・部署・メモ・タグで検索', value: listState.q, enterkeyhint: 'search', 'aria-label': '検索' });
  const sel = (key: 'category' | 'event' | 'tag' | 'sort', first: string, opts: [string, string][]) =>
    h('select', { 'aria-label': first, onchange: (e: Event) => { listState[key] = (e.target as HTMLSelectElement).value; void load(); } },
      ...[...(key === 'sort' ? [] : [['', first] as [string, string]]), ...opts].map(([v, l]) => h('option', { value: v, selected: listState[key] === v }, l)));
  const results = h('div', {}, h('p', { class: 'loading' }, '読み込み中…'));
  const filters = h('div', { class: 'filters' });
  const facetsP = api<{ events: { name: string; count: number }[]; tags: { name: string; count: number }[] }>('GET', '/api/facets');
  mount(h('div', { class: 'search' }, q), filters, results);
  let timer = 0;
  q.addEventListener('input', () => { clearTimeout(timer); timer = window.setTimeout(() => { listState.q = q.value; void load(); }, 250); });

  let seq = 0;
  async function load(): Promise<void> {
    const my = ++seq;
    const params = new URLSearchParams(Object.entries(listState).filter(([, v]) => v));
    try {
      const r = await api<{ total: number; cards: Summary[] }>('GET', `/api/cards?${params}`);
      if (my !== seq) return;
      results.replaceChildren(...renderList(r));
    } catch (e) {
      if (my !== seq) return;
      results.replaceChildren(h('div', { class: 'error-box' }, h('strong', {}, '一覧を読み込めませんでした'), h('p', {}, (e as Error).message), h('button', { class: 'btn', onclick: () => void load() }, '再試行')));
    }
  }
  void load();
  try {
    const f = await facetsP;
    filters.replaceChildren(
      sel('category', '分類：すべて', CATS),
      sel('event', 'イベント：すべて', f.events.map((x) => [x.name, `${x.name}（${x.count}）`])),
      sel('tag', 'タグ：すべて', f.tags.map((x) => [x.name, `${x.name}（${x.count}）`])),
      sel('sort', '並べ替え', [['created', '登録が新しい順'], ['exchange', '名刺交換日が新しい順'], ['company', '会社名順']]),
    );
  } catch { /* 一覧側でエラー表示 */ }
}

function renderList(r: { total: number; cards: Summary[] }): Node[] {
  if (r.total === 0) {
    return [h('div', { class: 'empty' }, h('div', { class: 'big' }, '📇'), h('p', {}, 'まだ名刺が登録されていません。'),
      h('a', { class: 'btn btn-primary', href: '#/new' }, '＋ 最初の名刺を登録する'))];
  }
  if (r.cards.length === 0) {
    return [h('div', { class: 'empty' }, h('p', {}, '条件に一致する名刺はありません。'), h('p', { class: 'small' }, '検索語や絞り込みを変えてお試しください。'))];
  }
  const role = (c: Summary) => [c.department, c.title].filter(Boolean).join(' ');
  return [
    h('p', { class: 'count' }, `${r.cards.length} 件${r.cards.length !== r.total ? `（全 ${r.total} 件中）` : ''}`),
    h('ul', { class: 'cards only-sp' }, ...r.cards.map((c) => h('li', {}, h('a', { href: `#/card/${c.id}` },
      h('div', { class: 'co' }, c.company || '（会社名なし）'),
      h('div', { class: 'nm' }, dispName(c)),
      h('div', { class: 'meta' }, role(c) ? h('span', {}, role(c)) : null, c.exchangeDate ? h('span', {}, `交換日 ${fmtDate(c.exchangeDate)}`) : null,
        c.category ? h('span', { class: 'chip' }, CAT_LABEL[c.category] ?? '') : null))))),
    h('table', { class: 'list only-pc' },
      h('thead', {}, h('tr', {}, ...['会社名', '氏名', '部署・役職', '交換日', 'イベント', '分類'].map((x) => h('th', { scope: 'col' }, x)))),
      h('tbody', {}, ...r.cards.map((c) => h('tr', { onclick: () => { location.hash = `#/card/${c.id}`; } },
        h('td', {}, c.company), h('td', {}, h('a', { href: `#/card/${c.id}` }, dispName(c)), c.kana ? h('div', { class: 'small muted' }, c.kana) : null),
        h('td', {}, role(c)), h('td', {}, fmtDate(c.exchangeDate)), h('td', {}, c.event),
        h('td', {}, c.category ? h('span', { class: 'chip' }, CAT_LABEL[c.category] ?? '') : ''))))),
  ];
}

// ---------------- 詳細 ----------------
function viewer(src: string): void {
  const img = h('img', { src, alt: '名刺画像（拡大）' });
  const v = h('div', { class: 'viewer', role: 'dialog', 'aria-label': '画像の拡大表示' },
    h('button', { class: 'btn btn-sm close', onclick: (e: Event) => { e.stopPropagation(); v.remove(); } }, '閉じる ✕'), img);
  img.addEventListener('click', () => v.classList.toggle('zoom'));
  document.addEventListener('keydown', function esc(e) { if (e.key === 'Escape') { v.remove(); document.removeEventListener('keydown', esc); } });
  document.body.append(v);
}
function safeUrl(u: string): string | null {
  const s = /^https?:\/\//i.test(u) ? u : `https://${u}`;
  try { const x = new URL(s); return x.protocol === 'http:' || x.protocol === 'https:' ? x.href : null; } catch { return null; }
}
async function viewDetail(id: string): Promise<void> {
  mount(h('p', { class: 'loading' }, '読み込み中…'));
  const c = await api<Card>('GET', `/api/cards/${id}`);
  const row = (label: string, v: Node | string | null) => (v ? [h('dt', {}, label), h('dd', {}, v)] : []);
  const tel = (v: string) => (v ? h('a', { href: `tel:${v.replace(/[^0-9+]/g, '')}` }, v) : null);
  const web = c.website ? safeUrl(c.website) : null;
  const dupBox = h('div', {});
  mount(h('div', { class: 'detail' },
    h('div', { class: 'row' }, h('a', { href: '#/', class: 'btn btn-ghost btn-sm' }, '← 一覧'), h('span', { class: 'spacer' }),
      h('a', { href: `#/card/${id}/edit`, class: 'btn btn-primary' }, '編集')),
    h('p', { class: 'muted mt12' }, c.company),
    h('h1', {}, dispName(c), c.kana ? h('span', { class: 'small muted' }, `　${c.kana}`) : null),
    dupBox,
    (c.frontImage || c.backImage) ? h('div', { class: 'images' },
      ...([['frontImage', '表'], ['backImage', '裏']] as const).map(([k, l]) => c[k]
        ? h('figure', { class: 'm0' }, h('img', { class: 'thumb', src: `/api/images/${c[k]}`, alt: `名刺画像（${l}）`, onclick: () => viewer(`/api/images/${c[k]}`) }), h('figcaption', { class: 'small muted' }, `${l}（タップで拡大）`))
        : h('div', {}))) : null,
    h('div', { class: 'panel' }, h('dl', {},
      ...row('部署', c.department), ...row('役職', c.title),
      ...row('電話番号', tel(c.phone)), ...row('携帯番号', tel(c.mobile)),
      ...row('メール', c.email ? h('a', { href: `mailto:${c.email}` }, c.email) : null),
      ...row('住所', [c.postalCode ? `〒${c.postalCode}` : '', c.address].filter(Boolean).join(' ')),
      ...row('Webサイト', web ? h('a', { href: web, target: '_blank', rel: 'noopener noreferrer' }, c.website) : c.website),
      ...row('交換日', fmtDate(c.exchangeDate)), ...row('会った場所', c.place), ...row('イベント', c.event),
      ...row('分類', CAT_LABEL[c.category] ?? ''),
      ...row('タグ', c.tags.length ? h('span', { class: 'row' }, ...c.tags.map((t) => h('span', { class: 'chip' }, t))) : null),
      ...row('メモ', c.memo ? h('div', { class: 'memo' }, c.memo) : null))),
    h('p', { class: 'small muted' }, `登録 ${new Date(c.createdAt).toLocaleString('ja-JP')}${c.createdByName ? `（${c.createdByName}）` : ''} ／ 更新 ${new Date(c.updatedAt).toLocaleString('ja-JP')}${c.updatedByName ? `（${c.updatedByName}）` : ''}`),
    h('button', { class: 'btn btn-danger', onclick: async () => {
      if (!confirm(`「${c.company} ${c.name}」を削除しますか？\n（共有フォルダ内のゴミ箱 trash に移動します）`)) return;
      try { await api('DELETE', `/api/cards/${id}?baseVersion=${c.version}`); toast('削除しました'); location.hash = '#/'; }
      catch (e) { alert(`削除できませんでした：${(e as Error).message}`); }
    } }, 'この名刺を削除')));
  void showDuplicates(dupBox, c, id);
}

async function showDuplicates(box: HTMLElement, f: Partial<Fields>, excludeId?: string): Promise<void> {
  try {
    const r = await api<{ cards: Summary[] }>('POST', '/api/duplicates', { company: f.company, name: f.name, email: f.email, phone: f.phone, mobile: f.mobile, excludeId });
    box.replaceChildren(...(r.cards.length ? [h('div', { class: 'warn-box' }, h('strong', {}, '重複の可能性がある名刺があります（自動統合はしません）'),
      h('ul', { class: 'dup' }, ...r.cards.map((d) => h('li', {}, h('a', { href: `#/card/${d.id}`, target: excludeId ? undefined : '_blank' }, `${d.company} ${d.name}`), d.exchangeDate ? ` （${fmtDate(d.exchangeDate)}）` : ''))))] : []));
  } catch { box.replaceChildren(); }
}

// ---------------- 画像処理 ----------------
const MAX_EDGE = 2000;
async function decode(blob: Blob): Promise<ImageBitmap | HTMLImageElement> {
  try { return await createImageBitmap(blob, { imageOrientation: 'from-image' }); } catch {
    const url = URL.createObjectURL(blob);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      return img;
    } finally { URL.revokeObjectURL(url); }
  }
}
/** 縮小・回転して JPEG に再エンコード（EXIF・位置情報などのメタデータは含まれない） */
async function processImage(src: Blob, rotation: number): Promise<Blob> {
  const img = await decode(src);
  const w0 = img.width, h0 = img.height;
  const scale = Math.min(1, MAX_EDGE / Math.max(w0, h0));
  const w = Math.round(w0 * scale), hh = Math.round(h0 * scale);
  const rot = ((rotation % 360) + 360) % 360;
  const canvas = document.createElement('canvas');
  canvas.width = rot % 180 ? hh : w; canvas.height = rot % 180 ? w : hh;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate((rot * Math.PI) / 180);
  ctx.drawImage(img, -w / 2, -hh / 2, w, hh);
  if ('close' in img) img.close();
  const out = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', 0.85));
  canvas.width = canvas.height = 0;
  if (!out) throw new Error('画像の変換に失敗しました。');
  return out;
}

interface Slot { id: string | null; source: Blob | null; rotation: number; preview: string | null; state: 'idle' | 'busy' | 'ok' | 'err'; msg: string; processed: Blob | null }

// ---------------- 登録・編集 ----------------
async function viewEdit(id: string | null, fromInbox: string[] = []): Promise<void> {
  mount(h('p', { class: 'loading' }, '読み込み中…'));
  let card: Card | null = id ? await api<Card>('GET', `/api/cards/${id}`) : null;
  const facets = await api<{ events: { name: string }[]; tags: { name: string }[] }>('GET', '/api/facets').catch(() => ({ events: [], tags: [] }));
  let baseVersion = card?.version ?? 0;
  const inputs = {} as Record<TextKey, HTMLInputElement | HTMLTextAreaElement>;
  const types: Partial<Record<TextKey, string>> = { phone: 'tel', mobile: 'tel', email: 'email', website: 'url', exchangeDate: 'date', postalCode: 'text' };
  const mk = (k: TextKey, extra: Record<string, unknown> = {}) => {
    const el = k === 'memo'
      ? h('textarea', { id: `f-${k}`, placeholder: '話した内容、紹介者、関係する案件など', ...extra })
      : h('input', { id: `f-${k}`, type: types[k] ?? 'text', autocomplete: 'off', ...extra });
    el.value = card ? card[k] : k === 'exchangeDate' ? today() : '';
    el.addEventListener('input', () => { dirty = true; scheduleDup(); });
    inputs[k] = el;
    return h('label', { class: 'field' }, h('span', { class: k === 'company' || k === 'name' ? 'req' : '' }, LABELS[k]), el);
  };
  const category = h('select', { id: 'f-category', onchange: () => { dirty = true; } }, h('option', { value: '' }, '未分類'), ...CATS.map(([v, l]) => h('option', { value: v, selected: card?.category === v }, l)));
  const tags = h('input', { id: 'f-tags', type: 'text', placeholder: 'スペースまたは読点（、）区切り', list: 'tag-list', value: card?.tags.join(' ') ?? '', oninput: () => { dirty = true; } });
  const parseTags = () => tags.value.split(/[\s,、，　]+/).map((x) => x.trim()).filter(Boolean);
  let dirty = false;
  dirtyGuard = () => dirty;

  // 画像スロット
  const slots: Record<'frontImage' | 'backImage', Slot> = {
    frontImage: { id: card?.frontImage ?? null, source: null, rotation: 0, preview: card?.frontImage ? `/api/images/${card.frontImage}` : null, state: 'idle', msg: '', processed: null },
    backImage: { id: card?.backImage ?? null, source: null, rotation: 0, preview: card?.backImage ? `/api/images/${card.backImage}` : null, state: 'idle', msg: '', processed: null },
  };
  const slotEls: Record<string, HTMLElement> = {};
  const inboxNote = h('div', {});
  const renderSlot = (k: 'frontImage' | 'backImage') => {
    const s = slots[k];
    const cam = h('input', { type: 'file', accept: 'image/*', capture: 'environment', class: 'visually-hidden', onchange: (e: Event) => pick(k, e) });
    const file = h('input', { type: 'file', accept: 'image/*', class: 'visually-hidden', onchange: (e: Event) => pick(k, e) });
    const busy = s.state === 'busy';
    slotEls[k]!.replaceChildren(
      h('div', { class: 'ttl' }, h('span', {}, k === 'frontImage' ? '表面' : '裏面')),
      h('div', { class: 'pv' }, s.preview ? h('img', { src: s.preview, alt: `${k === 'frontImage' ? '表' : '裏'}の画像`, onclick: () => s.preview && viewer(s.preview) }) : '画像なし'),
      h('div', { class: 'acts' },
        h('label', { class: 'btn btn-sm' }, '📷 撮影', cam),
        h('label', { class: 'btn btn-sm' }, '🖼 選択', file),
        s.preview ? h('button', { type: 'button', class: 'btn btn-sm', disabled: busy, onclick: () => void rotate(k) }, '↻ 回転') : null,
        s.preview ? h('button', { type: 'button', class: 'btn btn-sm', disabled: busy, onclick: () => { if (confirm('この画像を外しますか？（保存するまで確定しません）')) { Object.assign(s, { id: null, source: null, preview: null, state: 'idle', msg: '', processed: null }); dirty = true; renderSlot(k); } } }, '削除') : null,
        k === 'frontImage' && s.preview && status?.ocrAvailable ? h('button', { type: 'button', class: 'btn btn-sm', disabled: busy, onclick: () => void ocr() }, '文字を読み取る') : null,
        s.state === 'err' && s.processed ? h('button', { type: 'button', class: 'btn btn-sm btn-primary', onclick: () => void upload(k) }, '再試行') : null),
      h('div', { class: `st ${s.state}`, hidden: !s.msg }, s.msg));
  };
  const pick = (k: 'frontImage' | 'backImage', e: Event) => {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (!f) return;
    if (!f.type.startsWith('image/') && !/\.(jpe?g|png|heic|heif|webp)$/i.test(f.name)) { alert('画像ファイルを選択してください。'); return; }
    if (f.size > 40 * 1024 * 1024) { alert('画像が大きすぎます（40MBまで）。'); return; }
    Object.assign(slots[k], { source: f, rotation: 0 });
    dirty = true;
    void prepare(k);
  };
  const rotate = async (k: 'frontImage' | 'backImage') => {
    const s = slots[k];
    if (!s.source && s.id) {
      try { s.source = await (await fetch(`/api/images/${s.id}`, { cache: 'no-store' })).blob(); } catch { s.state = 'err'; s.msg = '画像を読み込めませんでした。'; renderSlot(k); return; }
    }
    s.rotation += 90; dirty = true;
    await prepare(k);
  };
  const prepare = async (k: 'frontImage' | 'backImage') => {
    const s = slots[k];
    Object.assign(s, { state: 'busy', msg: '画像を処理中…' }); renderSlot(k);
    try {
      s.processed = await processImage(s.source!, s.rotation);
      if (s.preview?.startsWith('blob:')) URL.revokeObjectURL(s.preview);
      s.preview = URL.createObjectURL(s.processed);
    } catch (e) {
      Object.assign(s, { state: 'err', msg: `画像を読み込めませんでした（${(e as Error).message}）。別の画像をお試しください。`, processed: null }); renderSlot(k); return;
    }
    await upload(k);
  };
  const upload = async (k: 'frontImage' | 'backImage') => {
    const s = slots[k];
    Object.assign(s, { state: 'busy', msg: 'アップロード中…' }); renderSlot(k);
    try {
      const r = await api<{ id: string }>('POST', '/api/images', undefined, s.processed!);
      Object.assign(s, { id: r.id, state: 'ok', msg: `アップロード完了（${Math.round(s.processed!.size / 1024)}KB）。名刺を保存すると確定します。` });
    } catch (e) {
      Object.assign(s, { id: null, state: 'err', msg: `アップロードに失敗しました：${(e as Error).message}` });
    }
    renderSlot(k);
  };

  // OCR
  const ocrBox = h('div', {});
  const ocr = async () => {
    const s = slots.frontImage;
    const blob = s.processed ?? (s.id ? await (await fetch(`/api/images/${s.id}`, { cache: 'no-store' })).blob() : null);
    if (!blob) return;
    const prog = h('div', { class: 'panel' }, '文字を読み取り中…（初回は数十秒かかることがあります）');
    ocrBox.replaceChildren(prog);
    try {
      const text = await runOcr(blob, (p) => { prog.textContent = `文字を読み取り中… ${Math.round(p * 100)}%`; });
      showCandidates(parseCardText(text), text);
    } catch (e) {
      ocrBox.replaceChildren(h('div', { class: 'error-box' }, `読み取りに失敗しました：${(e as Error).message}。手入力で登録できます。`));
    }
  };
  const showCandidates = (c: OcrCandidates, raw: string) => {
    const rows = (Object.entries(c) as [TextKey, string][]).filter(([, v]) => v).map(([k, v]) => {
      const cb = h('input', { type: 'checkbox', checked: !inputs[k].value });
      const val = h('input', { type: 'text', value: v });
      return { k, cb, val, el: h('label', {}, cb, h('span', { class: 'small' }, LABELS[k]), val) };
    });
    ocrBox.replaceChildren(h('div', { class: 'panel ocr-cands' },
      h('h2', { class: 'mt0' }, '読み取り結果（入力候補）'),
      h('p', { class: 'small muted' }, '読み取りは誤りを含みます。反映する項目にチェックを入れ、内容を確認・修正してください。保存は自動では行いません。'),
      rows.length ? rows.map((r) => r.el) : h('p', {}, '候補を抽出できませんでした。'),
      h('details', {}, h('summary', { class: 'small' }, '読み取った全文'), h('pre', { class: 'raw' }, raw)),
      h('div', { class: 'row' },
        h('button', { type: 'button', class: 'btn btn-primary', onclick: () => {
          for (const r of rows) if (r.cb.checked) inputs[r.k].value = r.val.value;
          dirty = true; ocrBox.replaceChildren(); toast('入力欄に反映しました。内容を確認して保存してください'); scheduleDup();
        } }, '選択した項目を入力欄に反映'),
        h('button', { type: 'button', class: 'btn', onclick: () => ocrBox.replaceChildren() }, '閉じる'))));
  };

  // 重複候補
  const dupBox = h('div', {});
  let dupTimer = 0;
  const scheduleDup = () => { clearTimeout(dupTimer); dupTimer = window.setTimeout(() => void showDuplicates(dupBox, collect(), id ?? undefined), 600); };

  const collect = (): Fields => {
    const f = {} as Fields;
    for (const k of TEXT) f[k] = inputs[k]?.value ?? '';
    f.category = category.value; f.tags = parseTags();
    f.frontImage = slots.frontImage.id; f.backImage = slots.backImage.id;
    return f;
  };

  // 保存
  const stateEl = h('div', { class: 'savestate', 'aria-live': 'assertive' }, id ? '' : '未保存');
  const errBox = h('div', {});
  const saveBtn = h('button', { type: 'submit', class: 'btn btn-primary' }, '保存');
  const setState = (cls: string, msg: string) => { stateEl.className = `savestate ${cls}`; stateEl.textContent = msg; };
  const save = async (e?: Event) => {
    e?.preventDefault();
    errBox.replaceChildren();
    const f = collect();
    if (!f.company.trim() && !f.name.trim()) { setState('failed', '会社名または氏名を入力してください。'); inputs.company.focus(); return; }
    if (Object.values(slots).some((s) => s.state === 'busy')) { setState('failed', '画像の処理・アップロードが終わってから保存してください。'); return; }
    if (Object.values(slots).some((s) => s.state === 'err')) { setState('failed', '画像のアップロードに失敗しています。「再試行」するか画像を削除してください。'); return; }
    saveBtn.disabled = true; setState('saving', '保存中…');
    try {
      const saved = card ? await api<Card & { inboxResult?: { failed: string[] } }>('PUT', `/api/cards/${card.id}`, { ...f, baseVersion })
        : await api<Card & { inboxResult?: { failed: string[] } }>('POST', '/api/cards', { ...f, fromInbox });
      dirty = false; dirtyGuard = null; card = saved; baseVersion = saved.version;
      setState('saved', '保存しました');
      if (saved.inboxResult?.failed.length) alert('名刺は保存しましたが、取り込み用フォルダの元画像を「取り込み済み」へ移動できませんでした。「未整理」画面に残っている場合は「破棄」してください。');
      toast('保存しました');
      location.hash = `#/card/${saved.id}`;
    } catch (x) {
      const err = x as ApiError;
      if (err.status === 409 && err.body.current) { setState('failed', '保存していません：他の端末で更新されています'); showConflict(err.body.current as Card, f); }
      else setState('failed', `保存に失敗しました：${err.message}（入力内容はこの画面に残っています。もう一度「保存」を押してください）`);
    } finally { saveBtn.disabled = false; }
  };
  const showConflict = (cur: Card, mine: Fields) => {
    const keys = [...TEXT, 'category', 'tags', 'frontImage', 'backImage'] as (keyof Fields)[];
    const fmt = (k: keyof Fields, v: unknown) => (k === 'tags' ? (v as string[]).join(' ') : k === 'category' ? CAT_LABEL[v as string] ?? '' : k.endsWith('Image') ? (v ? '画像あり' : 'なし') : String(v ?? ''));
    const diffs = keys.filter((k) => fmt(k, cur[k]) !== fmt(k, mine[k]));
    errBox.replaceChildren(h('div', { class: 'error-box' },
      h('strong', {}, '他の端末でこの名刺が更新されています。'),
      h('p', {}, `更新日時：${new Date(cur.updatedAt).toLocaleString('ja-JP')}。このまま保存すると相手側の変更を上書きします。`),
      h('table', { class: 'diff' }, h('tr', {}, h('th', {}, '項目'), h('th', {}, 'この画面の入力'), h('th', {}, '最新の保存内容')),
        ...diffs.map((k) => h('tr', {}, h('td', {}, LABELS[k] ?? k), h('td', {}, fmt(k, mine[k])), h('td', {}, fmt(k, cur[k]))))),
      h('div', { class: 'row mt8' },
        h('button', { type: 'button', class: 'btn btn-danger', onclick: () => { baseVersion = cur.version; card = cur; void save(); } }, 'この画面の内容で上書き保存'),
        h('button', { type: 'button', class: 'btn', onclick: () => { if (confirm('この画面の入力内容を破棄して最新の内容を読み込みますか？')) { dirty = false; dirtyGuard = null; void viewEdit(cur.id); } } }, '最新の内容を読み込む（入力は破棄）'))));
    errBox.scrollIntoView({ behavior: 'smooth' });
  };

  const hasDetail = !!card && ['phone', 'mobile', 'email', 'postalCode', 'address', 'website'].some((k) => card![k as TextKey]);
  const form = h('form', { onsubmit: save, novalidate: true },
    h('div', { class: 'row' }, h('a', { href: id ? `#/card/${id}` : '#/', class: 'btn btn-ghost btn-sm' }, '← 戻る')),
    h('h1', {}, id ? '名刺を編集' : '名刺を登録'),
    inboxNote,
    errBox,
    h('div', { class: 'images' }, (slotEls.frontImage = h('div', { class: 'slot' })), (slotEls.backImage = h('div', { class: 'slot' }))),
    ocrBox,
    dupBox,
    h('div', { class: 'grid2' }, mk('company'), mk('name'), mk('kana'), mk('department'), mk('title'), mk('exchangeDate'),
      mk('place'), mk('event', { list: 'event-list' }),
      h('label', { class: 'field' }, h('span', {}, '分類'), category), h('label', { class: 'field' }, h('span', {}, 'タグ'), tags)),
    mk('memo'),
    h('details', { class: 'more', open: hasDetail }, h('summary', {}, '連絡先・住所・Webサイト'),
      h('div', { class: 'grid2' }, mk('phone', { inputmode: 'tel' }), mk('mobile', { inputmode: 'tel' }), mk('email', { inputmode: 'email', autocapitalize: 'off' }),
        mk('website', { inputmode: 'url', autocapitalize: 'off' }), mk('postalCode', { inputmode: 'numeric', placeholder: '123-4567' }), mk('address'))),
    h('datalist', { id: 'event-list' }, ...facets.events.map((e) => h('option', { value: e.name }))),
    h('datalist', { id: 'tag-list' }, ...facets.tags.map((e) => h('option', { value: e.name }))),
    h('div', { class: 'savebar' }, stateEl, saveBtn));
  mount(form);
  renderSlot('frontImage'); renderSlot('backImage');
  // 「未整理」から開いた場合：取り込み用フォルダの画像を読み込んで表・裏に設定（縮小・メタデータ除去してからアップロード）
  if (fromInbox.length) {
    inboxNote.replaceChildren(h('div', { class: 'warn-box' }, '取り込み用フォルダの画像から登録します。保存すると元の画像は「取り込み済み」に移動します。'));
    dirty = true;
    const keys = ['frontImage', 'backImage'] as const;
    await Promise.all(fromInbox.map(async (iid, i) => {
      const k = keys[i]!;
      try {
        const c = await api<{ claimedBy: string | null }>('POST', `/api/inbox/${iid}/claim`);
        if (c.claimedBy) inboxNote.append(h('div', { class: 'warn-box' }, `この画像は ${c.claimedBy} さんが登録作業中の可能性があります。重複に注意してください。`));
        const r = await fetch(`/api/inbox/${iid}/file`, { cache: 'no-store', credentials: 'same-origin' });
        if (!r.ok) throw new Error(r.status === 404 ? '既に取り込まれたか、移動・削除されています' : `エラー ${r.status}`);
        slots[k].source = await r.blob();
        await prepare(k);
      } catch (e) {
        Object.assign(slots[k], { state: 'err', msg: `取り込み画像を読み込めませんでした：${(e as Error).message}`, processed: null });
        renderSlot(k);
      }
    }));
  }
  if (!status?.storage.available) setState('failed', '保存先（共有フォルダ）に接続できないため、現在は保存できません。');
}

// ---------------- 未整理（取り込み用フォルダ） ----------------
async function viewInbox(): Promise<void> {
  mount(h('p', { class: 'loading' }, '読み込み中…'));
  const r = await api<{ items: InboxItem[] }>('GET', '/api/inbox');
  const selected: string[] = [];
  const regBtn = h('button', { class: 'btn btn-primary', disabled: true, onclick: () => { location.hash = `#/new?inbox=${selected.join(',')}`; } }, '選んだ画像で登録');
  const discBtn = h('button', { class: 'btn btn-danger', disabled: true, onclick: async () => {
    if (!confirm(`選んだ ${selected.length} 枚を破棄しますか？\n（名刺としては登録せず、取り込み済みフォルダへ移動します）`)) return;
    try { await api('POST', '/api/inbox/discard', { ids: selected }); toast('破棄しました'); void viewInbox(); }
    catch (e) { alert(`破棄できませんでした：${(e as Error).message}`); }
  } }, '破棄');
  const hint = h('span', { class: 'small muted' }, '1〜2枚選んでください（1枚目＝表、2枚目＝裏）');
  const update = () => {
    regBtn.disabled = selected.length < 1 || selected.length > 2;
    discBtn.disabled = selected.length < 1;
    hint.textContent = selected.length ? `${selected.length} 枚選択中${selected.length > 2 ? '（登録は2枚まで）' : ''}` : '1〜2枚選んでください（1枚目＝表、2枚目＝裏）';
    document.querySelectorAll<HTMLElement>('.inbox-item').forEach((el) => {
      const i = selected.indexOf(el.dataset.id!);
      el.classList.toggle('sel', i >= 0);
      el.querySelector('.ord')!.textContent = i === 0 ? '表' : i === 1 ? '裏' : '';
    });
  };
  mount(h('div', {},
    h('h1', {}, '未整理の名刺画像'),
    h('p', { class: 'small muted' }, `取り込み用フォルダ（${status?.inbox.dir ?? ''}）に置かれた画像です。複合機のスキャンやPCからのコピーで追加できます。登録すると元の画像は「取り込み済み」へ移動します。`),
    r.items.length ? h('div', {},
      h('div', { class: 'row inbox-bar' }, regBtn, discBtn, hint, h('span', { class: 'spacer' }), h('button', { class: 'btn btn-sm', onclick: () => void viewInbox() }, '一覧を更新')),
      h('ul', { class: 'inbox' }, ...r.items.map((it) => h('li', {}, h('button', { type: 'button', class: 'inbox-item', 'data-id': it.id, onclick: () => {
        const i = selected.indexOf(it.id);
        if (i >= 0) selected.splice(i, 1); else selected.push(it.id);
        update();
      } },
        h('span', { class: 'ord' }),
        h('img', { src: `/api/inbox/${it.id}/file`, alt: it.name, loading: 'lazy', onerror: (e: Event) => { (e.target as HTMLElement).replaceWith(h('span', { class: 'noimg' }, 'プレビューできない形式です')); } }),
        h('span', { class: 'nm small' }, it.name),
        h('span', { class: 'small muted' }, `${new Date(it.mtime).toLocaleString('ja-JP')}${it.claimedBy ? ` ・${it.claimedBy} さんが作業中` : ''}`)))))) 
    : h('div', { class: 'empty' }, h('div', { class: 'big' }, '📥'), h('p', {}, '未整理の画像はありません。'), h('p', { class: 'small' }, '取り込み用フォルダに名刺画像（JPEG・PNG など）を入れると、ここに表示されます。'),
      h('button', { class: 'btn', onclick: () => void viewInbox() }, '一覧を更新'))));
  void refreshStatus();
}

// ---------------- 管理（バックアップ・復元・CSV） ----------------
async function viewAdmin(): Promise<void> {
  await refreshStatus();
  const list = h('div', {}, h('p', { class: 'loading' }, '読み込み中…'));
  const restoreBox = h('div', {});
  const loadBackups = async () => {
    try {
      const r = await api<{ backups: { name: string; kind: string; createdAt: string; size: number }[] }>('GET', '/api/backups');
      const kind: Record<string, string> = { auto: '自動', manual: '手動', 'pre-restore': '復元前の退避' };
      list.replaceChildren(r.backups.length ? h('table', { class: 'list backups' },
        h('thead', {}, h('tr', {}, h('th', {}, '作成日時'), h('th', {}, '種類'), h('th', {}, 'サイズ'), h('th', {}, '操作'))),
        h('tbody', {}, ...r.backups.map((b) => h('tr', {},
          h('td', {}, new Date(b.createdAt).toLocaleString('ja-JP')), h('td', {}, kind[b.kind] ?? b.kind), h('td', {}, `${(b.size / 1048576).toFixed(1)}MB`),
          h('td', {}, h('div', { class: 'row' },
            h('a', { class: 'btn btn-sm', href: `/api/backups/${encodeURIComponent(b.name)}/download`, download: b.name }, 'ダウンロード'),
            h('button', { class: 'btn btn-sm', onclick: () => void prepRestore({ backupName: b.name }) }, 'この時点に復元'))))))) : h('p', { class: 'muted' }, 'バックアップはまだありません。'));
    } catch (e) { list.replaceChildren(h('div', { class: 'error-box' }, (e as Error).message)); }
  };
  const prepRestore = async (src: { backupName?: string; file?: File }) => {
    restoreBox.replaceChildren(h('div', { class: 'panel' }, 'バックアップを検証しています…'));
    try {
      let ref: { backupName?: string; uploadId?: string };
      let s: { createdAt: string; cardCount: number; imageCount: number };
      if (src.file) {
        const r = await api<{ uploadId: string; summary: typeof s }>('POST', '/api/restore/upload', undefined, new Blob([src.file], { type: 'application/x-tar' }));
        ref = { uploadId: r.uploadId }; s = r.summary;
      } else {
        const r = await api<{ summary: typeof s }>('POST', '/api/restore/verify', { backupName: src.backupName });
        ref = { backupName: src.backupName }; s = r.summary;
      }
      const conf = h('input', { type: 'text', placeholder: '復元', 'aria-label': '確認入力' });
      const btn = h('button', { class: 'btn btn-danger', onclick: async () => {
        if (conf.value !== '復元') { alert('確認のため「復元」と入力してください。'); return; }
        btn.disabled = true; btn.textContent = '復元中…';
        try {
          const r = await api<{ summary: typeof s; preRestore: { name: string } }>('POST', '/api/restore/apply', { ...ref, confirm: '復元' });
          restoreBox.replaceChildren(h('div', { class: 'ok-box' }, `復元しました（名刺 ${r.summary.cardCount} 件・画像 ${r.summary.imageCount} 枚）。復元前のデータは「${r.preRestore.name}」に退避しました。`));
          void loadBackups();
        } catch (e) { restoreBox.replaceChildren(h('div', { class: 'error-box' }, `復元できませんでした：${(e as Error).message}（現在のデータは変更されていません）`)); }
      } }, '復元を実行');
      restoreBox.replaceChildren(h('div', { class: 'warn-box' },
        h('strong', {}, '検証OK：このバックアップに置き換えます'),
        h('p', {}, `作成：${new Date(s.createdAt).toLocaleString('ja-JP')}／名刺 ${s.cardCount} 件／画像 ${s.imageCount} 枚`),
        h('p', {}, '現在のデータは自動で「復元前の退避」バックアップに保存されてから置き換わります。確認のため「復元」と入力してください。'),
        h('div', { class: 'row' }, conf, btn, h('button', { class: 'btn', onclick: () => restoreBox.replaceChildren() }, 'やめる'))));
    } catch (e) { restoreBox.replaceChildren(h('div', { class: 'error-box' }, `このファイルは復元に使えません：${(e as Error).message}`)); }
  };
  const fileIn = h('input', { type: 'file', accept: '.tar,application/x-tar', class: 'visually-hidden', onchange: (e: Event) => { const f = (e.target as HTMLInputElement).files?.[0]; if (f) void prepRestore({ file: f }); } });
  const mkBtn = h('button', { class: 'btn btn-primary', onclick: async () => {
    mkBtn.disabled = true; mkBtn.textContent = '作成中…';
    try { const b = await api<{ name: string }>('POST', '/api/backups'); toast(`バックアップを作成しました`); void loadBackups(); void b; }
    catch (e) { alert(`バックアップを作成できませんでした：${(e as Error).message}`); }
    finally { mkBtn.disabled = false; mkBtn.textContent = '今すぐバックアップを作成'; }
  } }, '今すぐバックアップを作成');
  const st = status?.storage;
  const isAdmin = status?.user.role === 'admin';
  mount(h('div', {},
    h('h1', {}, '管理'),
    h('div', { class: 'panel' }, h('h2', { class: 'mt0' }, 'ログイン中'), h('p', {}, `${status?.user.name ?? ''}（${status?.user.id ?? ''}・${isAdmin ? '管理者' : '利用者'}）`),
      h('button', { class: 'btn', onclick: async () => { await api('POST', '/api/logout').catch(() => undefined); status = null; location.hash = '#/login'; } }, 'ログアウト')),
    status?.inbox.enabled ? h('div', { class: 'panel' }, h('h2', { class: 'mt0' }, '取り込み用フォルダ'), h('p', { class: 'small' }, status.inbox.dir ?? ''),
      status.inbox.error ? h('div', { class: 'error-box' }, status.inbox.error) : null) : null,
    h('div', { class: 'panel' }, h('h2', { class: 'mt0' }, '保存先'),
      st ? h('div', { class: st.available ? 'ok-box' : 'error-box' }, st.available ? '共有フォルダに接続しています。' : `接続できません：${st.error}`) : null,
      h('p', { class: 'small' }, `データ：${st?.dataDir ?? '-'}`, h('br'), `バックアップ：${st?.backupDir ?? '-'}`),
      status && !status.secure ? h('p', { class: 'small muted' }, '現在 HTTP で接続しています。社内証明書で HTTPS を構成すると通信が暗号化されます（導入手順書を参照）。') : null),
    !isAdmin ? h('p', { class: 'small muted' }, 'バックアップ・復元・CSV出力は管理者のみ利用できます。') : null,
    !isAdmin ? null : h('div', { class: 'panel' }, h('h2', { class: 'mt0' }, 'バックアップ'),
      h('p', { class: 'small muted' }, '自動バックアップは画像を含む全件を世代管理で保存します。バックアップが同じ共有ストレージ（NAS）内にある場合、ストレージ自体の故障には備えられません。定期的に「ダウンロード」して別の社内媒体にも保管してください。'),
      h('div', { class: 'row' }, mkBtn), h('div', { class: 'mt12' }, list)),
    !isAdmin ? null : h('div', { class: 'panel' }, h('h2', { class: 'mt0' }, '復元'),
      h('p', { class: 'small muted' }, '上の一覧から選ぶか、ダウンロードしたバックアップファイル（.tar）をアップロードします。復元前に形式とデータを検証します。'),
      h('label', { class: 'btn' }, 'バックアップファイルを選んで検証', fileIn), restoreBox),
    !isAdmin ? null : h('div', { class: 'panel' }, h('h2', { class: 'mt0' }, 'CSV出力'),
      h('p', { class: 'small' }, 'Excel で開ける CSV（UTF-8 BOM付き）で全件を出力します。', h('strong', {}, 'CSV には名刺画像は含まれません。'), '画像も含めて保存する場合はバックアップを使ってください。'),
      h('a', { class: 'btn', href: '/api/export.csv', download: true }, 'CSVをダウンロード'))));
  if (isAdmin) void loadBackups();
}

void route();
