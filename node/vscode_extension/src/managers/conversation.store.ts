import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { SessionInfo } from "@moonshot-ai/kimi-agent-sdk";
import type { UIStreamEvent } from "shared/types";

export type RecordedStreamEvent = UIStreamEvent & { _sessionId: string; _sequence: number };

interface ConversationIndex {
  version: 1;
  sessions: SessionInfo[];
}

interface InMemoryConversation {
  info: SessionInfo;
  events: RecordedStreamEvent[];
}

/**
 * ACP does not expose a transcript API. This store is therefore the extension's
 * source of truth for transcripts, independent of the CLI's internal files.
 */
export class ConversationStore {
  private readonly indexPath: string;
  private readonly eventDir: string;
  private readonly conversations = new Map<string, InMemoryConversation>();
  private index = new Map<string, SessionInfo>();
  private initialized: Promise<void> | null = null;
  private writes = new Map<string, Promise<void>>();

  constructor(storagePath: string) {
    this.indexPath = path.join(storagePath, "acp-conversations.json");
    this.eventDir = path.join(storagePath, "acp-conversation-events");
  }

  async create(info: SessionInfo): Promise<void> {
    await this.ensureInitialized();
    const existing = this.index.get(info.id);
    const normalized = { ...existing, ...info, updatedAt: existing?.updatedAt ?? info.updatedAt };
    this.index.set(info.id, normalized);
    const inMemory = this.conversations.get(info.id);
    this.conversations.set(info.id, { info: normalized, events: inMemory?.events ?? (existing ? await this.readEvents(info.id) : []) });
    await this.writeIndex();
  }

  append(sessionId: string, event: UIStreamEvent): RecordedStreamEvent {
    const conversation = this.conversations.get(sessionId);
    if (!conversation) {
      throw new Error(`Cannot record event for unknown conversation: ${sessionId}`);
    }

    const recorded: RecordedStreamEvent = {
      ...event,
      _sessionId: sessionId,
      _sequence: conversation.events.length + 1,
    };
    conversation.events.push(recorded);
    conversation.info.updatedAt = Date.now();
    this.index.set(sessionId, conversation.info);

    this.enqueue(sessionId, async () => {
      await fs.appendFile(this.eventPath(sessionId), `${JSON.stringify(recorded)}\n`, "utf-8");
    });
    this.enqueue("index", () => this.writeIndex());
    return recorded;
  }

  async getEvents(sessionId: string): Promise<RecordedStreamEvent[]> {
    await this.ensureInitialized();
    const inMemory = this.conversations.get(sessionId);
    if (inMemory) {
      return [...inMemory.events];
    }

    const info = this.index.get(sessionId);
    if (!info) {
      return [];
    }

    const events = await this.readEvents(sessionId);
    this.conversations.set(sessionId, { info, events });
    return [...events];
  }

  async list(workspaceRoot?: string): Promise<SessionInfo[]> {
    await this.ensureInitialized();
    const sessions = [...this.index.values()].sort((a, b) => b.updatedAt - a.updatedAt);
    if (!workspaceRoot) {
      return sessions;
    }
    return sessions.filter((session) => isWithinWorkspace(workspaceRoot, session.workDir));
  }

  async delete(sessionId: string): Promise<boolean> {
    await this.ensureInitialized();
    if (!this.index.has(sessionId)) {
      return false;
    }

    await this.flush(sessionId);
    this.index.delete(sessionId);
    this.conversations.delete(sessionId);
    await Promise.all([fs.rm(this.eventPath(sessionId), { force: true }), this.writeIndex()]);
    return true;
  }

  async flush(sessionId?: string): Promise<void> {
    if (sessionId) {
      await this.writes.get(sessionId);
      return;
    }
    await Promise.all([...this.writes.values()]);
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      this.initialized = this.loadIndex();
    }
    await this.initialized;
  }

  private async loadIndex(): Promise<void> {
    await fs.mkdir(this.eventDir, { recursive: true });
    try {
      const value = JSON.parse(await fs.readFile(this.indexPath, "utf-8")) as ConversationIndex;
      if (value.version === 1 && Array.isArray(value.sessions)) {
        this.index = new Map(value.sessions.map((session) => [session.id, session]));
      }
    } catch (error: unknown) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        console.warn("[conversation-store] Could not load conversation index:", error);
      }
    }
  }

  private async readEvents(sessionId: string): Promise<RecordedStreamEvent[]> {
    try {
      const content = await fs.readFile(this.eventPath(sessionId), "utf-8");
      return content
        .split(/\r?\n/)
        .filter(Boolean)
        .flatMap((line) => {
          try {
            const event = JSON.parse(line) as RecordedStreamEvent;
            return typeof event._sequence === "number" && typeof event._sessionId === "string" ? [event] : [];
          } catch {
            return [];
          }
        });
    } catch (error: unknown) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        console.warn("[conversation-store] Could not load conversation events:", error);
      }
      return [];
    }
  }

  private eventPath(sessionId: string): string {
    return path.join(this.eventDir, `${sessionId}.jsonl`);
  }

  private enqueue(key: string, operation: () => Promise<void>): void {
    const previous = this.writes.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(operation);
    this.writes.set(key, next);
  }

  private async writeIndex(): Promise<void> {
    await fs.mkdir(path.dirname(this.indexPath), { recursive: true });
    const content = JSON.stringify({ version: 1, sessions: [...this.index.values()] satisfies SessionInfo[] } satisfies ConversationIndex, null, 2);
    const tempPath = `${this.indexPath}.tmp`;
    await fs.writeFile(tempPath, content, "utf-8");
    await fs.rename(tempPath, this.indexPath);
  }
}

function isWithinWorkspace(workspaceRoot: string, workDir: string): boolean {
  const relative = path.relative(workspaceRoot, workDir);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}
