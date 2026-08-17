// 簡易ヘボン式ローマ字プリフィル: ふりがな(ひらがな/カタカナ)から素案の romaji を作る。
// あくまで入力補助 — 最終的な表記は本人が修正できる (フォーム側で編集を尊重)。網羅的な
// 変換器ではなく、拗音・促音・長音(ー)・撥音(ん) の基本ルールだけを扱う。
// 出力は先頭大文字・以降小文字 ("Yamada" / "Taro") にして氏名らしく整える。

// カタカナ -> ひらがな (0x60 のオフセット) に寄せてから 1 つの表で引く。
function toHiragana(input: string): string {
  let out = "";
  for (const ch of input) {
    const code = ch.codePointAt(0) ?? 0;
    // Katakana block (ァ..ヶ) -> Hiragana。長音記号 (ー) はそのまま残す。
    if (code >= 0x30a1 && code <= 0x30f6) out += String.fromCodePoint(code - 0x60);
    else out += ch;
  }
  return out;
}

// 拗音など 2 文字の組みを先に引く表 (最長一致)。
const DIGRAPHS: Record<string, string> = {
  きゃ: "kya", きゅ: "kyu", きょ: "kyo",
  しゃ: "sha", しゅ: "shu", しょ: "sho",
  ちゃ: "cha", ちゅ: "chu", ちょ: "cho",
  にゃ: "nya", にゅ: "nyu", にょ: "nyo",
  ひゃ: "hya", ひゅ: "hyu", ひょ: "hyo",
  みゃ: "mya", みゅ: "myu", みょ: "myo",
  りゃ: "rya", りゅ: "ryu", りょ: "ryo",
  ぎゃ: "gya", ぎゅ: "gyu", ぎょ: "gyo",
  じゃ: "ja", じゅ: "ju", じょ: "jo",
  びゃ: "bya", びゅ: "byu", びょ: "byo",
  ぴゃ: "pya", ぴゅ: "pyu", ぴょ: "pyo",
};

const MONOGRAPHS: Record<string, string> = {
  あ: "a", い: "i", う: "u", え: "e", お: "o",
  か: "ka", き: "ki", く: "ku", け: "ke", こ: "ko",
  さ: "sa", し: "shi", す: "su", せ: "se", そ: "so",
  た: "ta", ち: "chi", つ: "tsu", て: "te", と: "to",
  な: "na", に: "ni", ぬ: "nu", ね: "ne", の: "no",
  は: "ha", ひ: "hi", ふ: "fu", へ: "he", ほ: "ho",
  ま: "ma", み: "mi", む: "mu", め: "me", も: "mo",
  や: "ya", ゆ: "yu", よ: "yo",
  ら: "ra", り: "ri", る: "ru", れ: "re", ろ: "ro",
  わ: "wa", を: "o", ん: "n",
  が: "ga", ぎ: "gi", ぐ: "gu", げ: "ge", ご: "go",
  ざ: "za", じ: "ji", ず: "zu", ぜ: "ze", ぞ: "zo",
  だ: "da", ぢ: "ji", づ: "zu", で: "de", ど: "do",
  ば: "ba", び: "bi", ぶ: "bu", べ: "be", ぼ: "bo",
  ぱ: "pa", ぴ: "pi", ぷ: "pu", ぺ: "pe", ぽ: "po",
  ぁ: "a", ぃ: "i", ぅ: "u", ぇ: "e", ぉ: "o",
};

/** Capitalize just the first letter (氏名らしく). */
function titleCase(s: string): string {
  return s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1);
}

/**
 * ふりがな 1 語 (せい OR めい) を簡易ヘボン式 romaji にする。空文字は空文字を返す。
 * 変換できない文字は落とす (英字メール発行の素案なので非ラテン文字を残さない)。
 */
export function kanaToRomaji(kana: string): string {
  const src = toHiragana(kana.trim());
  let out = "";
  let i = 0;
  while (i < src.length) {
    const two = src.slice(i, i + 2);
    if (DIGRAPHS[two]) {
      out += DIGRAPHS[two];
      i += 2;
      continue;
    }
    const ch = src[i]!;
    // 促音 (っ): 次の子音を重ねる。
    if (ch === "っ") {
      const nextTwo = src.slice(i + 1, i + 3);
      const nextOne = src[i + 1] ?? "";
      const nextRomaji = DIGRAPHS[nextTwo] ?? MONOGRAPHS[nextOne] ?? "";
      if (nextRomaji) out += nextRomaji[0];
      i += 1;
      continue;
    }
    // 長音記号 (ー): 直前の母音を伸ばす代わりに、素案では単に無視する。
    if (ch === "ー") {
      i += 1;
      continue;
    }
    if (MONOGRAPHS[ch]) out += MONOGRAPHS[ch];
    // 未知の文字 (漢字など) は落とす。
    i += 1;
  }
  return titleCase(out);
}
