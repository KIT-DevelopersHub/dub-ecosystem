// Local stand-in for FE2's re-exported `useToast` (frozen 1-4-3: FE7 owns no toast
// implementation). In P1 this file is deleted and `useToast` is imported from the
// shell. Kept API-compatible with FE1 ToastOptions (kind 4種 + title/description).
import { create } from "zustand";

export type ToastKind = "success" | "error" | "info" | "warning";

export interface ToastOptions {
  kind: ToastKind;
  title: string;
  description?: string;
}

export interface ActiveToast extends ToastOptions {
  id: number;
}

interface ToastStore {
  toasts: ActiveToast[];
  show: (opts: ToastOptions) => void;
  dismiss: (id: number) => void;
}

let seq = 0;

export const useToastStore = create<ToastStore>((set) => ({
  toasts: [],
  show: (opts) => set((st) => ({ toasts: [...st.toasts, { ...opts, id: ++seq }] })),
  dismiss: (id) => set((st) => ({ toasts: st.toasts.filter((t) => t.id !== id) })),
}));

/** Hook matching the FE2 contract shape: returns { toast }. */
export function useToast(): { toast: (opts: ToastOptions) => void } {
  const show = useToastStore((s) => s.show);
  return { toast: show };
}
