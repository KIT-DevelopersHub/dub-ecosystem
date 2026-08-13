// Shared open-state for the notification dialog (FE5). Both entry points open the
// SAME modal: the header bell (inside NotificationProviders) and the shell Home
// "未読の通知" card. The card only flips this store; the dialog itself is rendered
// by the always-mounted header widget (which holds the NotificationProvider
// context), so there is no duplicate dialog and no duplicate data wiring.

import { create } from "zustand";

interface DialogStore {
  open: boolean;
  openDialog(): void;
  closeDialog(): void;
}

export const useNotificationDialogStore = create<DialogStore>((set) => ({
  open: false,
  openDialog: () => set({ open: true }),
  closeDialog: () => set({ open: false }),
}));

// Non-hook accessor so the shell Home card can open the dialog without pulling in
// FE5 React context (mirrors getUnreadCount for the nav badge).
export function openNotificationDialog(): void {
  useNotificationDialogStore.getState().openDialog();
}
