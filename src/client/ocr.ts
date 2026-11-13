// 端末内 OCR（Tesseract.js）。エンジン・言語データはすべてこのサーバーの /vendor/ocr/ から読み込み、外部へは送信しない。
export type OcrCandidates = Partial<Record<'company' | 'department' | 'title' | 'name' | 'kana' | 'phone' | 'mobile' | 'email' | 'postalCode' | 'address' | 'website', string>>;

interface TWorker { recognize(img: Blob): Promise<{ data: { text: string } }>; terminate(): Promise<void> }
interface TesseractMod { createWorker(lang: string, oem: number, opts: Record<string, unknown>): Promise<TWorker> }

export async function runOcr(img: Blob, onProgress: (p: number) => void): Promise<string> {
  const mod = (await import('/vendor/ocr/tesseract.esm.min.js' as string)) as { default?: TesseractMod } & TesseractMod;
  const T = mod.default ?? mod;
  const worker = await T.createWorker('jpn+eng', 1, {
    workerPath: '/vendor/ocr/worker.min.js',
    corePath: '/vendor/ocr/core/',
    langPath: '/vendor/ocr/lang',
    workerBlobURL: false,
    cacheMethod: 'none',
    gzip: true,
    logger: (m: { status: string; progress: number }) => { if (m.status === 'recognizing text') onProgress(m.progress); },
  });
  try {
    const r = await worker.recognize(img);
    return r.data.text;
  } finally {
    await worker.terminate();
  }
}

const CJK = '\\u3040-\\u30ff\\u3400-\\u9fff\\uff66-\\uff9f';
/** 読み取った全文から入力候補を推定する（あくまで候補。利用者が確認・修正して保存する） */
export function parseCardText(text: string): OcrCandidates {
  const out: OcrCandidates = {};
  const lines = text.normalize('NFKC').split(/\n+/)
    .map((l) => l.replace(new RegExp(`([${CJK}])\\s+(?=[${CJK}])`, 'g'), '$1').replace(/\s+/g, ' ').trim())
    .filter((l) => l.length > 0);
  const used = new Set<number>();
  const take = (i: number) => used.add(i);

  lines.forEach((l, i) => {
    const em = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+/.exec(l);
    if (em && !out.email) { out.email = em[0]; take(i); }
    const url = /(https?:\/\/)?(www\.)[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+(\/\S*)?|https?:\/\/[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+(\/\S*)?/.exec(l.replace(/[A-Za-z0-9._%+-]+@\S+/, ''));
    if (url && !out.website) { out.website = url[0]; take(i); }
    const zip = /〒?\s*(\d{3})\s*[-ー−]\s*(\d{4})/.exec(l);
    if (zip && !out.postalCode && (/〒/.test(l) || /[都道府県]/.test(l))) {
      out.postalCode = `${zip[1]}-${zip[2]}`;
      const rest = l.replace(zip[0], '').trim();
      if (rest && /[都道府県市区町村]/.test(rest)) out.address = rest;
      take(i);
    }
    const phones = l.match(/\+?\d{1,4}[\s()-]*\d{1,4}[\s()-]*\d{3,4}(?:[\s()-]*\d{3,4})?/g) ?? [];
    for (const p of phones) {
      const digits = p.replace(/\D/g, '');
      if (digits.length < 10 || digits.length > 13) continue;
      if (/fax|ファクス|ファックス|F\s*[:.]/i.test(l) && !/tel|電話|携帯|mobile/i.test(l)) continue;
      const mobile = /^(0[789]0|\+?81[789]0)/.test(digits) || /携帯|mobile|cell/i.test(l);
      if (mobile && !out.mobile) out.mobile = p.trim();
      else if (!mobile && !out.phone) out.phone = p.trim();
      take(i);
    }
  });
  lines.forEach((l, i) => {
    if (used.has(i)) return;
    if (!out.company && /株式会社|有限会社|合同会社|\(株\)|㈱|(Co\.|Inc\.?|Ltd\.?|Corporation|Corp\.)/i.test(l)) { out.company = l; take(i); return; }
    if (!out.address && /(東京都|北海道|京都府|大阪府|.{2,3}県).{1,}[市区町村郡]/.test(l)) { out.address = l; take(i); return; }
    if (!out.title && /(代表取締役|取締役|社長|部長|課長|係長|主任|室長|所長|店長|マネージャー|リーダー|Manager|Director|CEO|President)/i.test(l)) {
      const m = /^(.+?(?:部|課|室|局|グループ|センター|支店))\s*(代表取締役.*|取締役.*|社長|部長|課長|係長|主任|室長|所長|店長|マネージャー|リーダー)$/.exec(l);
      if (m) { out.department = m[1]!.trim(); out.title = m[2]!.trim(); }
      else out.title = l;
      take(i); return;
    }
    if (!out.department && /(部|課|室|本部|事業部|グループ|センター|支店|営業所)$/.test(l) && l.length <= 30) { out.department = l; take(i); return; }
  });
  // 氏名：残りの行のうち、漢字・かな 2〜10 文字（空白1つまで）の短い行
  lines.forEach((l, i) => {
    if (used.has(i)) return;
    if (!out.kana && /^[ぁ-ゖー ]{2,20}$/.test(l)) { out.kana = l; take(i); return; }
    if (!out.name && new RegExp(`^[${CJK}々]{1,5} ?[${CJK}々]{1,5}$`).test(l)) { out.name = l; take(i); }
  });
  return out;
}

// ---------- ChatGPT などの AI での読み取り（コピー＆ペースト。アプリからは送信しない） ----------

/** AI に渡す指示文。回答は JSON だけにしてもらい、アプリが入力候補として読み込む */
export const AI_PROMPT = `添付の名刺画像（表・裏）から情報を読み取り、次の JSON だけを出力してください。説明文やコードブロックの記号は不要です。
読み取れない・書かれていない項目は "" にしてください。推測で補わないでください。
{
  "company": "会社名",
  "department": "部署",
  "title": "役職",
  "name": "氏名（姓と名の間は半角スペース）",
  "kana": "氏名のふりがな（ひらがな。名刺に書かれていない場合は \\"\\"）",
  "phone": "電話番号（代表・直通）",
  "mobile": "携帯電話番号",
  "email": "メールアドレス",
  "postalCode": "郵便番号（123-4567 の形）",
  "address": "住所（郵便番号を除く）",
  "website": "Webサイトの URL"
}`;

const AI_KEYS = ['company', 'department', 'title', 'name', 'kana', 'phone', 'mobile', 'email', 'postalCode', 'address', 'website'] as const;
const AI_ALIASES: Record<string, (typeof AI_KEYS)[number]> = {
  会社名: 'company', 部署: 'department', 役職: 'title', 氏名: 'name', ふりがな: 'kana', 電話番号: 'phone', 電話: 'phone',
  携帯番号: 'mobile', 携帯: 'mobile', メールアドレス: 'email', メール: 'email', 郵便番号: 'postalCode', 住所: 'address', webサイト: 'website', ウェブサイト: 'website', url: 'website',
};

/** AI の回答（JSON。前後の説明文や ```json を含んでもよい）から入力候補を取り出す */
export function parseAiAnswer(text: string): OcrCandidates {
  const t = text.replace(/```(?:json)?/gi, '');
  const a = t.indexOf('{');
  const b = t.lastIndexOf('}');
  if (a < 0 || b <= a) throw new Error('回答に JSON が見つかりません。ChatGPT の回答全体をコピーして貼り付けてください。');
  let obj: unknown;
  try { obj = JSON.parse(t.slice(a, b + 1)); } catch { throw new Error('回答の JSON を読み取れませんでした。もう一度 ChatGPT に「JSON だけを出力して」と頼んでください。'); }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('回答の形式が想定と違います。');
  const out: OcrCandidates = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const key = (AI_KEYS as readonly string[]).includes(k) ? (k as (typeof AI_KEYS)[number]) : AI_ALIASES[k.toLowerCase()] ?? AI_ALIASES[k];
    if (!key || typeof v !== 'string') continue;
    const val = v.normalize('NFKC').replace(/\s+/g, ' ').trim().slice(0, 300);
    if (val) out[key] = val;
  }
  if (!Object.keys(out).length) throw new Error('回答から読み取れた項目がありません。');
  return out;
}
