import { create } from "zustand";
import type { DisplayBlock, ApprovalResponse } from "@moonshot-ai/kimi-agent-sdk/schema";
import { bridge } from "@/services";

export interface ApprovalRequest {
  id: string;
  sessionId: string | null;
  tool_call_id: string;
  sender: string;
  action: string;
  description: string;
  display: DisplayBlock[];
}

interface ApprovalState {
  pending: ApprovalRequest[];
  addRequest: (request: ApprovalRequest) => void;
  removeRequest: (id: string) => void;
  respondToRequest: (id: string, response: ApprovalResponse) => Promise<void>;
  clearRequests: () => void;
}

export const useApprovalStore = create<ApprovalState>((set, get) => ({
  pending: [],

  addRequest: (request) => {
    set((s) => ({ pending: [...s.pending, request] }));
  },

  removeRequest: (id) => {
    set((s) => ({ pending: s.pending.filter((r) => r.id !== id) }));
  },

  respondToRequest: async (id, response) => {
    const request = get().pending.find((item) => item.id === id);
    await bridge.respondApproval(id, response, request?.sessionId ?? undefined);
    get().removeRequest(id);
  },

  clearRequests: () => {
    set({ pending: [] });
  },
}));
