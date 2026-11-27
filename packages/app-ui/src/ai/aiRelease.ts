// AI の公開状態 (#879)。イベントの「AI のまとめ」・質問欄 (FE3) と、ヘッダーの AI パネル (FE2)
// が同じ値を読む。公開予定日を変える時はここだけ直し、Mac mini が動いたら AI_CHAT_AVAILABLE を true にする。
export const AI_RELEASE_DATE_LABEL = "12/3";
export const AI_CHAT_AVAILABLE = false;
export const AI_UNAVAILABLE_MESSAGE = `現在は利用できません。${AI_RELEASE_DATE_LABEL} 公開予定です。`;
