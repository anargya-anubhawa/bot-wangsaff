/**
 * GX-ID — temporary mail (mail.tm)
 *
 * Creates disposable inboxes and reads their messages. Used by
 * `plugins/tools/tempmail.js`.
 *
 * The service is `mail.tm` (public REST API):
 *   1. GET  /domains           → pick an active domain
 *   2. POST /accounts          → create the mailbox
 *   3. POST /token             → obtain a bearer token
 *   4. GET  /messages          → list inbox
 *   5. GET  /messages/<id>     → read one message
 *
 * Exports:
 *   TempMailCreate()      → { status, email, id, password, token } | { status:false, error }
 *   TempMailInbox(address) → { status, count, messages:[{from,subject,created_at,body_text}] } | { status:false, error }
 */
import axios from "axios";

const BASE = "https://api.mail.tm";
const UA = "GX-ID-TempMail/1.0";

function client(token) {
  return axios.create({
    baseURL: BASE,
    timeout: 30000,
    headers: {
      Accept: "application/json",
      "User-Agent": UA,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
}

function randomPassword() {
  return `gx-${Math.random().toString(36).slice(2)}-${Date.now()}`;
}

function randomLocal() {
  return `gx${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
}

/** Pick the first active, non-private domain. */
async function pickDomain() {
  const { data } = await client().get("/domains");
  const list = data?.["hydra:member"] || (Array.isArray(data) ? data : []);
  const usable = list.filter((d) => d.isActive !== false && d.isPrivate !== true);
  const domain = usable[0]?.domain || list[0]?.domain;
  if (!domain) throw new Error("Tidak ada domain yang tersedia");
  return domain;
}

/**
 * Create a fresh temporary mailbox.
 * @returns {Promise<{status:boolean,email?:string,password?:string,token?:string,id?:string,error?:string}>}
 */
export async function TempMailCreate() {
  try {
    const domain = await pickDomain();
    const address = `${randomLocal()}@${domain}`;
    const password = randomPassword();

    const { data: account } = await client().post("/accounts", { address, password });
    const { data: auth } = await client().post("/token", { address, password });

    return {
      status: true,
      email: address,
      password,
      id: account?.id,
      token: auth?.token,
    };
  } catch (error) {
    const message =
      error?.response?.data?.["hydra:description"] ||
      error?.response?.data?.message ||
      error?.message ||
      "Gagal membuat email sementara";
    return { status: false, error: message };
  }
}

/**
 * Read the inbox for a mailbox. Re-authenticates when the stored token is
 * missing (the plugin only persists the address, so we cannot rely on a token).
 * Because mail.tm requires the password to mint a token, the plugin keeps the
 * password alongside the address in the user record.
 *
 * @param {string} address
 * @param {string} [password]
 */
export async function TempMailInbox(address, password) {
  if (!address) return { status: false, error: "Email kosong" };
  if (!password) {
    return { status: false, error: "Sesi email hilang — buat ulang dengan `.tempmail create`." };
  }
  try {
    const { data: auth } = await client().post("/token", { address, password });
    const token = auth?.token;
    const api = client(token);

    const { data } = await api.get("/messages");
    const list = data?.["hydra:member"] || [];

    const messages = [];
    for (const item of list.slice(0, 20)) {
      let bodyText = "";
      try {
        const { data: full } = await api.get(`/messages/${item.id}`);
        bodyText = full?.text || stripHtml(full?.html?.[0] || "") || "";
      } catch {
        bodyText = item.intro || "";
      }
      messages.push({
        from: item.from?.address || item.from?.name || "-",
        subject: item.subject || "(tanpa subjek)",
        created_at: item.createdAt ? new Date(item.createdAt).toLocaleString("id-ID") : "-",
        body_text: bodyText || item.intro || "(tidak ada isi)",
      });
    }

    return { status: true, count: list.length, messages };
  } catch (error) {
    const message =
      error?.response?.data?.["hydra:description"] ||
      error?.response?.data?.message ||
      error?.message ||
      "Gagal memeriksa inbox";
    return { status: false, error: message };
  }
}

/** Very small HTML→text reducer for message bodies. */
function stripHtml(html) {
  return String(html || "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .trim();
}
