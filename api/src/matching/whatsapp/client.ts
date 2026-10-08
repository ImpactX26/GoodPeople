/**
 * WhatsApp Cloud API, called with plain fetch. Needs WHATSAPP_PHONE_NUMBER_ID and
 * WHATSAPP_TOKEN; without both, messages are printed to the console instead.
 */
import type { Message } from "./templates.ts";
import { toWhatsApp } from "./phone.ts";

export interface WhatsAppClient {
  /** Throws when Meta rejects the message. */
  send(to: string, msg: Message): Promise<void>;
}

const env = process.env;
export const whatsappEnv = {
  phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID ?? "",
  token: env.WHATSAPP_TOKEN ?? "",
  verifyToken: env.WHATSAPP_VERIFY_TOKEN ?? "",
  appSecret: env.WHATSAPP_APP_SECRET ?? "",
  /** Templates must be approved by Meta first; until then plain messages are sent. */
  useTemplates: env.WHATSAPP_TEMPLATES === "1",
  templateLang: env.WHATSAPP_TEMPLATE_LANG ?? "en",
  apiVersion: env.WHATSAPP_API_VERSION ?? "v23.0",
};

export const whatsappConfigured = Boolean(whatsappEnv.phoneNumberId && whatsappEnv.token);

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

export function body(to: string, msg: Message, useTemplates = whatsappEnv.useTemplates): Record<string, unknown> {
  const base = { messaging_product: "whatsapp", recipient_type: "individual", to: toWhatsApp(to) };
  if (useTemplates && msg.template) {
    return {
      ...base,
      type: "template",
      template: {
        name: msg.template.name,
        language: { code: whatsappEnv.templateLang },
        components: [
          { type: "body", parameters: msg.template.params.map((p) => ({ type: "text", text: p })) },
          ...(msg.buttons ?? []).map((b, i) => ({
            type: "button",
            sub_type: "quick_reply",
            index: String(i),
            parameters: [{ type: "payload", payload: b.id }],
          })),
        ],
      },
    };
  }
  if (msg.buttons?.length) {
    return {
      ...base,
      type: "interactive",
      interactive: {
        type: "button",
        body: { text: clip(msg.text, 1024) },
        action: { buttons: msg.buttons.slice(0, 3).map((b) => ({ type: "reply", reply: { id: b.id, title: clip(b.title, 20) } })) },
      },
    };
  }
  return { ...base, type: "text", text: { body: clip(msg.text, 4096), preview_url: true } };
}

export function cloudClient(): WhatsAppClient {
  const url = `https://graph.facebook.com/${whatsappEnv.apiVersion}/${whatsappEnv.phoneNumberId}/messages`;
  return {
    async send(to, msg) {
      const res = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${whatsappEnv.token}`, "Content-Type": "application/json" },
        body: JSON.stringify(body(to, msg)),
      });
      if (!res.ok) throw new Error(`WhatsApp ${res.status}: ${(await res.text()).slice(0, 300)}`);
    },
  };
}

export const consoleClient: WhatsAppClient = {
  async send(to, msg) {
    const buttons = msg.buttons?.length ? `  [${msg.buttons.map((b) => b.title).join("] [")}]` : "";
    console.log(`[whatsapp → ${to}] ${msg.text}${buttons}`);
  },
};

export const defaultClient = (): WhatsAppClient => (whatsappConfigured ? cloudClient() : consoleClient);
