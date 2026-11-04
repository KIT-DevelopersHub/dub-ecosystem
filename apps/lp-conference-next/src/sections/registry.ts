// 登録簿の正本は @dub/types（packages/types/src/lp.ts）。LP はパッケージの dist ではなくソースを直接読む:
// build-bundle.mjs は版ごとに git archive するので、その版のコミット時点の登録簿でビルドされる。
export { LP_SECTION_REGISTRY, type LpSectionId } from "../../../../packages/types/src/lp";
