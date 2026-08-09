// FE6 public surface for the FE2 shell (design §2-3). One FeatureModule object:
// routes + nav entry (badgeSource = useChatUnreadTotal) + lazy chunks. When lifted
// into apps/admin-spa this file moves to features/chat/index.ts and imports the
// real "@spa/shell" contract in place of ./shell-contract.
import type { FeatureModule } from "./shell-contract";
import { useChatUnreadTotal } from "./store/useChatStore";

export { useChatUnreadTotal };
export type { ChatRuntime } from "./context";
export { ChatRuntimeProvider } from "./context";
export { ChatApp } from "./components/ChatApp";

export const chatFeature: FeatureModule = {
  id: "chat",
  nav: {
    id: "chat",
    label: "チャット",
    to: "/chat",
    icon: "chat",
    badgeSource: useChatUnreadTotal,
  },
  routes: [
    {
      path: "/chat",
      component: () => import("./routes/ChatHomeRoute").then((m) => ({ default: m.ChatHomeRoute })),
    },
    {
      path: "/chat/channels/$channelId",
      component: () => import("./routes/ChannelRoute").then((m) => ({ default: m.ChannelRoute })),
      requiredPermissions: [],
    },
    {
      path: "/chat/channels/$channelId/settings",
      component: () => import("./routes/ChannelSettingsRoute").then((m) => ({ default: m.ChannelSettingsRoute })),
      requiredPermissions: ["chat:moderate"],
    },
  ],
};
