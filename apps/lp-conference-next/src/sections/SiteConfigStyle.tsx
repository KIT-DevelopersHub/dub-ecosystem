import { LP_SECTION_REGISTRY } from "./registry";
import { siteConfigCss } from "./slots";

const CSS = siteConfigCss(LP_SECTION_REGISTRY);

/** 公開設定の CSS（登録簿から生成・ビルド時に固定）。 */
export function SiteConfigStyle() {
  return <style id="lp-site-config" dangerouslySetInnerHTML={{ __html: CSS }} />;
}
