// Minimal raw Telegram Bot API client (no third-party library).

export interface TgUser {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
  is_bot?: boolean;
}

export interface TgChat {
  id: number;
  type: "private" | "group" | "supergroup" | "channel";
  title?: string;
}

export interface TgPhotoSize {
  file_id: string;
  file_unique_id?: string;
  width: number;
  height: number;
  file_size?: number;
}

export interface TgFile {
  file_id: string;
  duration?: number;
  mime_type?: string;
  file_size?: number;
  file_name?: string;
}

export interface TgEntity {
  type: string;
  offset: number;
  length: number;
  user?: TgUser;
}

export interface TgMessage {
  message_id: number;
  message_thread_id?: number;
  is_topic_message?: boolean;
  from?: TgUser;
  chat: TgChat;
  date: number;
  text?: string;
  caption?: string;
  entities?: TgEntity[];
  caption_entities?: TgEntity[];
  reply_to_message?: TgMessage;
  photo?: TgPhotoSize[];
  voice?: TgFile;
  audio?: TgFile;
  video?: TgFile;
  video_note?: TgFile;
  animation?: TgFile;
  document?: TgFile;
  sticker?: TgFile;
}

export interface TgCallbackQuery {
  id: string;
  from: TgUser;
  message?: { message_id: number; chat: TgChat };
  data?: string;
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  edited_message?: TgMessage;
  callback_query?: TgCallbackQuery;
}

export interface ApiResult<T> {
  ok: boolean;
  result?: T;
  status: number;
  description?: string;
}

export class TelegramApi {
  constructor(private readonly apiBase: string, private readonly token: string) {}

  /** POST a Bot API method. Never throws on HTTP/API errors; network errors do throw. */
  async call<T = unknown>(method: string, body: Record<string, unknown> = {}, signal?: AbortSignal): Promise<ApiResult<T>> {
    const res = await fetch(`${this.apiBase}/bot${this.token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    type Body = { ok?: boolean; result?: T; description?: string };
    const data = (await res.json().catch(() => null)) as Body | null; // non-JSON error body → null
    return { ok: res.ok && !!data?.ok, result: data?.result, status: res.status, description: data?.description };
  }

  /** multipart/form-data upload of one local file as `field` (objects in `fields` are sent as JSON). */
  async upload<T = unknown>(method: string, fields: Record<string, unknown>, field: string, path: string, name: string): Promise<ApiResult<T>> {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) if (v !== undefined) form.append(k, typeof v === "object" ? JSON.stringify(v) : String(v));
    form.append(field, Bun.file(path), name);
    const res = await fetch(`${this.apiBase}/bot${this.token}/${method}`, { method: "POST", body: form });
    type Body = { ok?: boolean; result?: T; description?: string };
    const data = (await res.json().catch(() => null)) as Body | null;
    return { ok: res.ok && !!data?.ok, result: data?.result, status: res.status, description: data?.description };
  }

  fileUrl(filePath: string): string {
    return `${this.apiBase}/file/bot${this.token}/${filePath}`;
  }
}
