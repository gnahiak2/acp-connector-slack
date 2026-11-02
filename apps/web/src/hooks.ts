import { useCallback, useEffect, useRef, useState } from "react";
import { EVENT_TYPES, type PublicEvent } from "@slackboard/shared/events";

export const useAsync = <T>(
  loader: (signal: AbortSignal) => Promise<T>,
  deps: readonly unknown[],
): {
  data: T | undefined;
  error: string | undefined;
  loading: boolean;
  reload: () => void;
  setData: React.Dispatch<React.SetStateAction<T | undefined>>;
} => {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setLoading(true);
    setError(undefined);
    loader(controller.signal)
      .then((result) => {
        if (!active) return;
        setData(result);
        setLoading(false);
      })
      .catch((caught: unknown) => {
        if (!active || controller.signal.aborted) return;
        setError(caught instanceof Error ? caught.message : String(caught));
        setLoading(false);
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [...deps, nonce]);
  const reload = useCallback(() => setNonce((value) => value + 1), []);
  return { data, error, loading, reload, setData };
};

export type StreamStatus = "idle" | "connecting" | "open" | "reconnecting" | "closed";

export const useSessionStream = (
  sessionId: string | undefined,
  initialAfter: number,
  onEvent: (event: PublicEvent) => void,
  onReset: () => void,
): StreamStatus => {
  const [status, setStatus] = useState<StreamStatus>("idle");
  const lastSeq = useRef(initialAfter);
  const onEventRef = useRef(onEvent);
  const onResetRef = useRef(onReset);
  onEventRef.current = onEvent;
  onResetRef.current = onReset;
  useEffect(() => {
    lastSeq.current = initialAfter;
  }, [sessionId, initialAfter]);

  useEffect(() => {
    if (!sessionId) return;
    let source: EventSource | undefined;
    let timer: number | undefined;
    let stopped = false;
    let attempt = 0;

    const connect = (): void => {
      if (stopped) return;
      setStatus(attempt === 0 ? "connecting" : "reconnecting");
      const url = `/api/sessions/${encodeURIComponent(sessionId)}/stream?after=${lastSeq.current}`;
      source = new EventSource(url, { withCredentials: true });
      source.onopen = () => {
        attempt = 0;
        setStatus("open");
      };
      source.onerror = () => {
        source?.close();
        if (stopped) return;
        setStatus("reconnecting");
        attempt += 1;
        const delay = Math.min(1_000 * 2 ** Math.min(attempt, 4), 15_000);
        timer = window.setTimeout(connect, delay);
      };
      const handle = (raw: MessageEvent<string>): void => {
        try {
          const event = JSON.parse(raw.data) as PublicEvent;
          if (typeof event.seq === "number") {
            if (event.seq <= lastSeq.current) return;
            lastSeq.current = event.seq;
          }
          onEventRef.current(event);
        } catch {
          // Ignore malformed events; the server rejects malformed input.
        }
      };
      for (const type of EVENT_TYPES) source.addEventListener(type, handle as EventListener);
      source.addEventListener("replay-truncated", () => onResetRef.current());
    };

    connect();
    return () => {
      stopped = true;
      if (timer) window.clearTimeout(timer);
      source?.close();
      setStatus("closed");
    };
  }, [sessionId]);

  return status;
};
