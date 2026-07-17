import { create } from "zustand";
import type { Review } from "../lib/api";

export interface ChatMessage {
  role: "user" | "assistant";
  text: string;
}

interface UiState {
  review: Review | null;
  tileId: string;
  selectedNodeId: string | null;
  transitioning: "in" | "out" | null;
  chat: ChatMessage[];
  chatBusy: boolean;
  setReview: (r: Review | null) => void;
  navigateTile: (tileId: string) => void;
  selectNode: (nodeId: string | null) => void;
  setTransitioning: (t: "in" | "out" | null) => void;
  pushChat: (m: ChatMessage) => void;
  appendToLastChat: (text: string) => void;
  setChatBusy: (b: boolean) => void;
  clearChat: () => void;
}

export const useUi = create<UiState>((set) => ({
  review: null,
  tileId: "root",
  selectedNodeId: null,
  transitioning: null,
  chat: [],
  chatBusy: false,
  setReview: (review) => set({ review, tileId: "root", selectedNodeId: null, chat: [] }),
  navigateTile: (tileId) => set({ tileId, selectedNodeId: null }),
  selectNode: (selectedNodeId) => set({ selectedNodeId }),
  setTransitioning: (transitioning) => set({ transitioning }),
  pushChat: (m) => set((s) => ({ chat: [...s.chat, m] })),
  appendToLastChat: (text) =>
    set((s) => {
      const chat = [...s.chat];
      const last = chat[chat.length - 1];
      if (last && last.role === "assistant") chat[chat.length - 1] = { ...last, text: last.text + text };
      return { chat };
    }),
  setChatBusy: (chatBusy) => set({ chatBusy }),
  clearChat: () => set({ chat: [] }),
}));

// --- URL sync (deep links: ?repo=owner/name&pr=1&tile=root/a&node=n:x) ---
export function syncUrl(review: Review | null, tileId: string, nodeId: string | null): void {
  const params = new URLSearchParams();
  if (review) {
    params.set("repo", `${review.owner}/${review.repo}`);
    params.set("pr", String(review.prNumber));
    params.set("tile", tileId);
    if (nodeId) params.set("node", nodeId);
  }
  const qs = params.toString();
  history.replaceState(null, "", qs ? `?${qs}` : location.pathname);
}

export function readUrl(): { repo: string | null; pr: number | null; tile: string; node: string | null } {
  const p = new URLSearchParams(location.search);
  return {
    repo: p.get("repo"),
    pr: p.get("pr") ? Number(p.get("pr")) : null,
    tile: p.get("tile") ?? "root",
    node: p.get("node"),
  };
}
