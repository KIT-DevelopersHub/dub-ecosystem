// FE6 public surface for the FE2 shell (design §2-3). One FeatureModule object:
// lazy routes + a nav entry (badgeSource = useChatUnreadTotal). Shape matches FE2's
// canonical contract — apps/fe2-app-shell/src/modules/types.tsx (cross-PR source);
// ./shell-contract mirrors it locally. When lifted into apps/admin-spa this file moves
// to features/chat/index.ts and imports "@spa/shell" in place of ./shell-contract.
//
// ChatRuntimeProvider (re-exported below) is the documented injection point: FE2 wraps
// the mounted feature and supplies the real ChatApiClient + realtime client factory.
import type { FeatureModule } from "./shell-contract";
import { useChatUnreadTotal } from "./store/useChatStore";

export { useChatUnreadTotal };
export type { ChatRuntime } from "./context";
export { ChatRuntimeProvider } from "./context";
export { ChatApp } from "./components/ChatApp";

export const chatFeature: FeatureModule = {
  id: "chat",
  nav: [
    {
      label: "チャット",
      path: "/chat",
      // Must be a member of FE2's canonical IconName union (fe2 stubs/icons.tsx);
      // "chat" is not in that set — FE2 uses "message-square" for the chat nav.
      icon: "message-square",
      order: 40,
      badgeSource: useChatUnreadTotal,
    },
  ],
  routes: [
    {
      path: "/chat",
      lazy: () => import("./routes/ChatHomeRoute").then((m) => ({ Component: m.ChatHomeRoute })),
      auth: "required",
    },
    {
      path: "/chat/channels/$channelId",
      lazy: () => import("./routes/ChannelRoute").then((m) => ({ Component: m.ChannelRoute })),
      auth: "required",
    },
    {
      path: "/chat/channels/$channelId/settings",
      lazy: () => import("./routes/ChannelSettingsRoute").then((m) => ({ Component: m.ChannelSettingsRoute })),
      auth: "required",
      requiredPermissions: ["chat:moderate"],
    },
  ],
};
