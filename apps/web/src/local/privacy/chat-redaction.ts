/** 尽力识别聊天中的敏感信息；原文和金额映射只留在浏览器。 */
export interface LocalAmountRef { id: string; cents: number; currency?: 'CNY' | 'USD' }
function chineseNumber(text: string): number {
  const digits: Record<string, number> = { 零:0, 〇:0, 一:1, 二:2, 两:2, 三:3, 四:4, 五:5, 六:6, 七:7, 八:8, 九:9 };
  const units: Record<string, number> = { 十:10, 百:100, 千:1000, 万:10000, 亿:100000000 };
  if (!/[十百千万亿点]/.test(text)) return Number([...text].map(char=>digits[char]).join(''));
  const decimal=text.match(/^(.*)点([零〇一二两三四五六七八九]+)(万|亿)?$/);
  if(decimal) return (chineseNumber(decimal[1])+Number(`0.${[...decimal[2]].map(char=>digits[char]).join('')}`))*(decimal[3]==='亿'?1e8:decimal[3]==='万'?1e4:1);
  let total = 0, section = 0, number = 0, lastUnit = 1;
  for (const char of text) {
    if (char in digits) { number = digits[char]; continue; }
    const unit = units[char]; if (!unit) return NaN;
    lastUnit = unit;
    if (unit >= 10000) { total += (section + number || 1) * unit; section = 0; }
    else section += (number || 1) * unit;
    number = 0;
  }
  if (number > 0 && lastUnit >= 1000 && !text.includes('零') && !text.includes('〇')) number *= lastUnit / 10;
  return total + section + number;
}
export function redactChatText(raw: string, previous: LocalAmountRef[] = [], nickname?: string) {
  const amounts = previous.map(value => ({ ...value }));
  let redactions = 0;
  const hidden = (label: string) => { redactions++; return `[已隐藏${label}]`; };
  let text = raw.replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{12,})\b/g, () => hidden('密钥'))
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, () => hidden('邮箱'))
    .replace(/(?<!\d)\d[\d -]{13,}\d(?!\d)/g, () => hidden('账号'))
    .replace(/(?<!\d)1[3-9]\d{9}(?!\d)/g, () => hidden('手机'));
  if (nickname?.trim() && text.includes(nickname.trim())) text = text.split(nickname.trim()).join(hidden('称呼'));
  text = text.replace(/(?:[¥￥$]\s*)?(?:\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?|[零〇一二两三四五六七八九十百千万亿点]+)\s*(?:亿元|万元|千元|百元|元|块钱|块|万|亿|[wWkK])?/g,
    (match: string, offset: number, whole: string) => {
      // 已有引用、日期、时长和百分比不作为新金额处理。
      if (/amount_$/.test(whole.slice(Math.max(0, offset - 7), offset))) return match;
      if (/^\s*(?:个?月|年|周|天|日|号|%|％)/.test(whole.slice(offset + match.length))) return match;
      const cleaned = match.replace(/[¥￥$\s,]/g, '');
      const arabic = cleaned.match(/^(\d+(?:\.\d+)?)(亿|万|千|百|w|k)?(?:元|块钱|块)?$/i);
      const numeric = arabic
        ? Number(arabic[1]) * ({ 亿:1e8, 万:1e4, 千:1e3, 百:100, w:1e4, k:1e3 }[arabic[2]?.toLowerCase() ?? ''] ?? 1)
        : chineseNumber(cleaned.replace(/(?:元|块钱|块)$/, ''));
      const markedMoney = /[元块万亿wWkK¥￥$]/.test(match);
      if (!markedMoney && (!/^\d/.test(cleaned) || numeric < 100)) return match;
      const cents = Math.round(numeric * 100);
      if (!Number.isSafeInteger(cents) || cents < 0 || cents > 10_000_000_000) return hidden('金额');
      const currency = match.includes('$') ? 'USD' : 'CNY';
      let ref = amounts.find(value => value.cents === cents && (value.currency ?? 'CNY') === currency);
      if (!ref) {
        if (amounts.length >= 32) return hidden('金额');
        ref = { id: `amount_${amounts.length + 1}`, cents, ...(currency === 'USD' ? { currency } : {}) };
        amounts.push(ref);
      }
      redactions++;
      return `[金额:${ref.id}]`;
    });
  return { text, amounts, redactions };
}
export function renderLocalAmounts(text: string, amounts: LocalAmountRef[]): string {
  return text.replace(/\[金额:(amount_\d+)\]/g, (_all, id: string) => {
    const ref = amounts.find(value => value.id === id);
    return ref ? `${(ref.cents / 100).toLocaleString('zh-CN', { maximumFractionDigits: 2 })}${ref.currency === 'USD' ? '美元' : '元'}` : '这笔预算';
  });
}
