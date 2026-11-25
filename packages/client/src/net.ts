import { parseServerMessage, type ClientMessage, type ServerMessage } from '@blastmates/shared';

export function wsUrl(): string {
  if (import.meta.env.VITE_WS_URL) return import.meta.env.VITE_WS_URL;
  if (import.meta.env.DEV) return `ws://${location.hostname}:8080`;
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`;
}

export class Net {
  private ws: WebSocket | null = null;
  onMessage: (msg: ServerMessage) => void = () => {};
  onClose: () => void = () => {};

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl());
      this.ws = ws;
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error('Could not connect to server'));
      ws.onmessage = (ev) => {
        const msg = parseServerMessage(String(ev.data));
        if (msg) this.onMessage(msg);
      };
      ws.onclose = () => {
        if (this.ws === ws) {
          this.ws = null;
          this.onClose();
        }
      };
    });
  }

  send(msg: ClientMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  close(): void {
    const ws = this.ws;
    this.ws = null; // suppress onClose handler: this is an intentional close
    ws?.close();
  }

  get connected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }
}
