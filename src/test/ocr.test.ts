import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCardText } from '../client/ocr.js';

test('OCR：カタカナふりがなと漢字の氏名を分離する', () => {
  const c = parseCardText('株式会社架空商事\nヤマダ タロウ\n山田 太郎');
  assert.equal(c.name, '山田太郎');
  assert.equal(c.kana, 'やまだたろう');
  assert.equal(c.company, '株式会社架空商事');
});
test('OCR：同じ行のFAX・電話・携帯を番号ごとのラベルで分類する', () => {
  for (const line of ['FAX 03-9999-1111 TEL 03-1234-5678 MOBILE 090-1234-5678', 'TEL 03-1234-5678 FAX 03-9999-1111 携帯 090-1234-5678']) {
    const c = parseCardText(line);
    assert.equal(c.phone, '03-1234-5678');
    assert.equal(c.mobile, '090-1234-5678');
  }
  assert.equal(parseCardText('FAX 03-9999-1111').phone, undefined);
});
test('OCR：全角数字・国際電話・独立した郵便番号・メールを拾う', () => {
  const c = parseCardText('１００−０００１\n東京都千代田区架空町1-2-3\n携帯 +81-90-1234-5678\nmail: taro@example.invalid');
  assert.equal(c.postalCode, '100-0001');
  assert.equal(c.mobile, '+81-90-1234-5678');
  assert.equal(c.email, 'taro@example.invalid');
  assert.equal(c.address, '東京都千代田区架空町1-2-3');
});
