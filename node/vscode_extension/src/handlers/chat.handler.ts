import * as vscode from "vscode";
import * as path from "node:path";
import * as fs from "fs";
import { Methods, Events } from "../../shared/bridge";
import { VSCodeSettings } from "../config/vscode-settings";
import { BaselineManager } from "../managers";
import { getErrorCode, CliError } from "@moonshot-ai/kimi-agent-sdk";
import type { ContentPart, ApprovalResponse, RunResult } from "@moonshot-ai/kimi-agent-sdk";
import type { Handler } from "./types";
import type { ErrorPhase, UIStreamEvent } from "../../shared/types";
import { classifyError, getUserMessage } from "shared/errors";

interface StreamChatParams {
  content: string | ContentPart[];
  model: string;
  thinking: boolean;
  sessionId?: string;
}

interface SessionTarget {
  sessionId?: string;
}

interface RespondApprovalParams {
  requestId: string;
  response: ApprovalResponse;
}

interface RespondQuestionParams {
  rpcRequestId: string;
  questionRequestId: string;
  answers: Record<string, string>;
}

interface PendingToolCall {
  id: string;
  name: string;
  arguments: string;
  baselineSaved: boolean;
}

const FILE_TOOLS = new Set(["WriteFile", "CreateFile", "StrReplaceFile", "PatchFile", "DeleteFile", "AppendFile"]);

// Track sessions: sessionId -> last injected file path
const injectedEditorContextSessions = new Map<string, string>();

function buildSystemContext(sessionId: string): string {
  const mode = VSCodeSettings.editorContext;
  if (mode === "never") {
    return "";
  }

  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return "";
  }

  const doc = editor.document;
  const relativePath = vscode.workspace.asRelativePath(doc.uri);
  const lastPath = injectedEditorContextSessions.get(sessionId);

  if (mode === "onConversationStart") {
    // Already injected once, skip
    if (lastPath !== undefined) {
      return "";
    }
  } else {
    // onFileChange: skip if same file
    if (lastPath === relativePath) {
      return "";
    }
  }

  injectedEditorContextSessions.set(sessionId, relativePath);

  const sel = editor.selection;

  const selectionInfo = !sel.isEmpty ? ` (L${sel.start.line + 1}-${sel.end.line + 1} selected)` : "";
  const unsavedInfo = doc.isDirty ? ", unsaved" : "";

  return `<system>Editor context (use only if relevant to user's query): ${relativePath}:${sel.active.line + 1}${selectionInfo}${unsavedInfo}.</system>\n`;
}

function prependSystemContext(content: string | ContentPart[], ctx: string): string | ContentPart[] {
  if (!ctx) {
    return content;
  }

  if (typeof content === "string") {
    return content + "\n" + ctx;
  }

  const idx = content.findIndex((p) => p.type === "text");
  if (idx >= 0) {
    const copy = [...content];
    const part = copy[idx] as { type: "text"; text: string };
    copy[idx] = { type: "text", text: ctx + part.text };
    return copy;
  }

  return [{ type: "text", text: ctx }, ...content];
}

function conversationBrief(content: string | ContentPart[]): string {
  const text = typeof content === "string" ? content : content.find((part) => part.type === "text")?.text ?? "";
  return text.replace(/\s+/g, " ").trim().slice(0, 160) || "Untitled conversation";
}

function saveBaselineForPath(filePath: string, workDir: string, sessionId: string): boolean {
  const absolutePath = path.isAbsolute(filePath) ? filePath : path.join(workDir, filePath);
  const relativePath = path.relative(workDir, absolutePath);

  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    return false;
  }

  let content = "";
  if (fs.existsSync(absolutePath)) {
    try {
      content = fs.readFileSync(absolutePath, "utf-8");
    } catch {
      // File unreadable, use empty baseline (for new files)
    }
  }

  BaselineManager.saveBaseline(workDir, sessionId, relativePath, content);
  return true;
}

function tryParseAndSaveBaseline(call: PendingToolCall, workDir: string, sessionId: string): boolean {
  if (call.baselineSaved || !FILE_TOOLS.has(call.name) || !call.arguments) {
    return false;
  }

  try {
    const args = JSON.parse(call.arguments);
    if (args.path && saveBaselineForPath(args.path, workDir, sessionId)) {
      call.baselineSaved = true;
      return true;
    }
  } catch {
    // JSON not complete yet or invalid
  }
  return false;
}

const streamChat: Handler<StreamChatParams, { done: boolean }> = async (params, ctx) => {
  if (!ctx.workDir) {
    ctx.broadcast(
      Events.StreamEvent,
      {
        type: "error",
        code: "NO_WORKSPACE",
        message: "Please open a folder to start.",
        phase: "preflight" as ErrorPhase,
      },
      ctx.webviewId,
    );
    vscode.window.showWarningMessage("Spec Kimi: Please open a folder first.", "Open Folder").then((a) => {
      if (a) {
        vscode.commands.executeCommand("vscode.openFolder");
      }
    });
    return { done: false };
  }

  if (VSCodeSettings.autosave) {
    await ctx.saveAllDirty();
  }

  const session = await ctx.getOrCreateSession(params.model, params.thinking, params.sessionId);
  const workDir = ctx.workDir;
  const sessionId = session.sessionId;

  await ctx.conversationStore.create({
    id: sessionId,
    workDir,
    contextFile: "",
    updatedAt: Date.now(),
    brief: conversationBrief(params.content),
  });

  const emit = (event: UIStreamEvent) => {
    const recorded = ctx.recordSessionEvent(sessionId, event);
    ctx.broadcast(Events.StreamEvent, recorded, ctx.webviewId);
  };

  // Track pending tool calls for baseline saving
  BaselineManager.initSession(workDir, sessionId);

  emit({ type: "session_start", sessionId, model: session.model, slashCommands: session.slashCommands });

  const systemContext = buildSystemContext(sessionId);
  const contentWithContext = prependSystemContext(params.content, systemContext);

  const pendingToolCalls = new Map<string, PendingToolCall>();
  let lastToolCallId: string | null = null;

  try {
    const turn = session.prompt(contentWithContext);
    ctx.setTurn(sessionId, turn);

    let result: RunResult = { status: "finished" };

    for await (const event of turn) {
      // If the turn was aborted, drop subsequent events but keep draining the
      // stream so the underlying prompt request can complete cleanly.
      if (!ctx.getTurn(sessionId)) {
        continue;
      }

      const eventAny = event as any;
      const eventType = event.type;
      const payload = eventAny.payload;

      // ToolCall: Record and try to save baseline immediately if args are complete
      if (eventType === "ToolCall" && payload?.id) {
        const call: PendingToolCall = {
          id: payload.id,
          name: payload.function?.name || "",
          arguments: payload.function?.arguments || "",
          baselineSaved: false,
        };
        pendingToolCalls.set(payload.id, call);
        lastToolCallId = payload.id;

        // Try to save baseline immediately (for YOLO / approve_for_session where args come complete)
        tryParseAndSaveBaseline(call, workDir, sessionId);
      }

      // ToolCallPart: Accumulate arguments and try to save baseline
      if (eventType === "ToolCallPart" && payload?.arguments_part && lastToolCallId) {
        const call = pendingToolCalls.get(lastToolCallId);
        if (call) {
          call.arguments += payload.arguments_part;
          // Try to save after each part (will succeed when JSON becomes complete)
          tryParseAndSaveBaseline(call, workDir, sessionId);
        }
      }

      // StatusUpdate: Last chance to save baseline before potential file modification
      if (eventType === "StatusUpdate") {
        for (const call of pendingToolCalls.values()) {
          tryParseAndSaveBaseline(call, workDir, sessionId);
        }
      }

      // ToolResult: Clean up
      if (eventType === "ToolResult" && payload?.tool_call_id) {
        pendingToolCalls.delete(payload.tool_call_id);
        if (lastToolCallId === payload.tool_call_id) {
          lastToolCallId = null;
        }
      }

      emit(event);
    }

    result = await turn.result;

    emit({ type: "stream_complete", result });
    ctx.setTurn(sessionId, null);

    return { done: true };
  } catch (err) {
    ctx.setTurn(sessionId, null);

    const code = getErrorCode(err);
    const phase = classifyError(code);
    // 优先使用完整的原始 JSON 响应
    const detail = err instanceof CliError && err.rawResponse ? err.rawResponse : err instanceof Error ? err.message : String(err);
    const message = getUserMessage(code, err instanceof Error ? err.message : String(err));

    emit({
        type: "error",
        code,
        message,
        detail,
        phase,
      });

    return { done: false };
  }
};

const abortChat: Handler<SessionTarget, { aborted: boolean }> = async (params, ctx) => {
  const sessionId = params.sessionId ?? ctx.getSessionId();
  const turn = sessionId ? ctx.getTurn(sessionId) : undefined;
  if (turn) {
    // Mark the turn as aborted before awaiting the cancel request so that any
    // events still arriving from the CLI are dropped immediately instead of
    // continuing to render in the UI.
    ctx.setTurn(sessionId!, null);
    await turn.interrupt();
  }
  return { aborted: true };
};

const respondApproval: Handler<RespondApprovalParams & SessionTarget, { ok: boolean }> = async (params, ctx) => {
  const turn = ctx.getTurn(params.sessionId);
  turn?.approve(params.requestId, params.response);
  return { ok: true };
};

const respondQuestion: Handler<RespondQuestionParams & SessionTarget, { ok: boolean }> = async (params, ctx) => {
  const turn = ctx.getTurn(params.sessionId);
  if (turn) {
    await turn.respondQuestion(params.rpcRequestId, params.questionRequestId, params.answers);
  }
  return { ok: true };
};

interface SetPlanModeParams {
  enabled: boolean;
}

const setPlanMode: Handler<SetPlanModeParams & SessionTarget, { ok: boolean; planMode: boolean }> = async (params, ctx) => {
  const session = ctx.getSession(params.sessionId);
  if (!session) {
    return { ok: false, planMode: false };
  }
  const planMode = await session.setPlanMode(params.enabled);
  return { ok: true, planMode };
};

interface SteerChatParams {
  content: string | ContentPart[];
}

const steerChat: Handler<SteerChatParams & SessionTarget, { ok: boolean }> = async (params, ctx) => {
  const turn = ctx.getTurn(params.sessionId);
  if (!turn) {
    return { ok: false };
  }
  await turn.steer(params.content);
  return { ok: true };
};

const resetSession: Handler<SessionTarget, { ok: boolean }> = async (params, ctx) => {
  const session = ctx.getSession(params.sessionId);
  if (session) {
    injectedEditorContextSessions.delete(session.sessionId);
  }
  await ctx.closeSession(params.sessionId);
  ctx.fileManager.clearTracked(ctx.webviewId);
  return { ok: true };
};

export const chatHandlers: Record<string, Handler<any, any>> = {
  [Methods.StreamChat]: streamChat,
  [Methods.AbortChat]: abortChat,
  [Methods.RespondApproval]: respondApproval,
  [Methods.RespondQuestion]: respondQuestion,
  [Methods.SetPlanMode]: setPlanMode,
  [Methods.SteerChat]: steerChat,
  [Methods.ResetSession]: resetSession,
};
