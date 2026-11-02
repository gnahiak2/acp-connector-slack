import type { WebClient } from "@slack/web-api";
import { escapeSlackText, splitSlackMessage } from "./chunk.js";

export class SlackApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SlackApiError";
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export const withSlackRetry = async <T>(operation: () => Promise<T>, attempts = 3): Promise<T> => {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      const candidate = error as { retryAfter?: number; code?: string; message?: string };
      if (attempt === attempts - 1) break;
      const retryAfter = candidate.retryAfter;
      if (typeof retryAfter === "number" && retryAfter > 0) {
        await sleep(Math.min(retryAfter * 1_000, 30_000));
      } else {
        await sleep(500 * 2 ** attempt);
      }
    }
  }
  throw new SlackApiError(
    `Slack API call failed: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
};

export interface SlackStreamOptions {
  client: WebClient;
  channel: string;
  threadTs: string;
  chunkChars: number;
  updateIntervalMs: number;
  initialText?: string;
}

interface StreamState {
  ts: string;
  pending: string;
  openedFence: boolean;
}

export class SlackStreamer {
  private state?: StreamState;
  private timer?: NodeJS.Timeout;
  private stopped = false;
  private preStart = "";
  private readonly posted: string[] = [];

  constructor(private readonly options: SlackStreamOptions) {}

  async start(initialText = "Working…"): Promise<void> {
    if (this.state || this.stopped) return;
    const response = await withSlackRetry(() =>
      this.options.client.chat.postMessage({
        channel: this.options.channel,
        thread_ts: this.options.threadTs,
        text: initialText,
        mrkdwn: true,
      }),
    );
    const ts = response.ts;
    if (!ts) throw new SlackApiError("Slack did not return a message timestamp");
    this.posted.push(ts);
    this.state = { ts, pending: "", openedFence: false };
  }

  append(text: string): void {
    if (this.stopped) return;
    const escaped = escapeSlackText(text);
    if (!this.state) {
      this.preStart += escaped;
      void this.start().then(() => {
        if (!this.state) return;
        this.state.pending += this.preStart;
        this.preStart = "";
        this.schedule();
      });
      return;
    }
    this.state.pending += escaped;
    this.schedule();
  }

  setStatus(text: string): void {
    if (this.stopped) return;
    const escaped = escapeSlackText(text);
    if (!this.state) {
      void this.start(escaped);
      return;
    }
    void this.replaceCurrent(escaped);
  }

  async finish(finalText?: string): Promise<void> {
    if (this.stopped) return;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (finalText !== undefined) {
      this.state = this.state ?? undefined;
      if (!this.state) {
        await this.start(escapeSlackText(finalText));
        return;
      }
      this.state.pending = escapeSlackText(finalText);
    }
    await this.flush(true);
  }

  async fail(message: string): Promise<void> {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const text = `:warning: ${escapeSlackText(message)}`;
    if (!this.state) {
      await this.start(text);
    } else {
      await this.replaceCurrent(text);
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private schedule(): void {
    if (this.timer || this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush(false);
    }, this.options.updateIntervalMs);
    this.timer.unref();
  }

  private async flush(force: boolean): Promise<void> {
    if (!this.state || this.stopped) return;
    while (this.state.pending.length > this.options.chunkChars) {
      const chunks = splitSlackMessage(this.state.pending, this.options.chunkChars);
      if (chunks.length < 2) break;
      const first = chunks[0]!;
      await this.replaceCurrent(first);
      const response = await withSlackRetry(() =>
        this.options.client.chat.postMessage({
          channel: this.options.channel,
          thread_ts: this.options.threadTs,
          text: chunks[1] ?? "",
          mrkdwn: true,
        }),
      );
      if (!response.ts) throw new SlackApiError("Slack did not return a message timestamp");
      this.state.ts = response.ts;
      this.posted.push(response.ts);
      this.state.pending = chunks.slice(1).join("\n");
    }
    if (force || this.state.pending.length > 0) {
      await this.replaceCurrent(this.state.pending || (force ? "_No output._" : "Working…"));
    }
  }

  private async replaceCurrent(text: string): Promise<void> {
    if (!this.state) return;
    await withSlackRetry(() =>
      this.options.client.chat.update({
        channel: this.options.channel,
        ts: this.state!.ts,
        text,
      }),
    );
  }
}
