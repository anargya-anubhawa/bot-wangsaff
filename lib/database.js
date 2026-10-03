/**
 * GX-ID — database
 *
 * Multi-file JSON store built on lowdb, mirroring the reference architecture:
 *   users.json, groups.json, settings.json, stats.json, notes.json
 * Autosaves dirty stores every 5 seconds and flushes on exit. Writes are
 * atomic (tmp file + rename) and corrupt files are backed up and reset.
 */
import fs from "fs";
import path from "path";
import { logger } from "./logger.js";
import config from "../config.js";
import { normalizeEntry } from "./content-detectors.js";

const FLUSH_INTERVAL_MS = 5000;

const DEFAULTS = {
  users: {},
  groups: {},
  settings: { selfMode: false },
  stats: {},
  notes: {},
  filters: {},
  blacklists: {},
  registrations: {},
  federations: {},
  links: {},
  schedules: {},
  levels: {},
  whitelist: [],
  scopes: {},
  eventLogs: {},
};

/**
 * Live accessors that map the legacy GX-ID field names onto the canonical
 * GX-ID user fields. They are non-enumerable, so they never get persisted —
 * only the canonical `energi` / `koin` / `saldo` values are written to disk.
 */
const LEGACY_ALIASES = {
  limit: {
    get() { return this.energi ?? 0; },
    set(v) { this.energi = Number(v) || 0; },
  },
  money: {
    get() { return this.koin ?? 0; },
    set(v) { this.koin = Number(v) || 0; },
  },
  balance: {
    get() { return this.saldo ?? this.koin ?? 0; },
    set(v) { this.saldo = Number(v) || 0; },
  },
  premium: {
    get() { return !!this.isPremium; },
    set(v) { this.isPremium = !!v; },
  },
  registered: {
    get() { return !!this.isRegistered; },
    set(v) { this.isRegistered = !!v; },
  },
};

function applyLegacyAliases(user) {
  if (!user || typeof user !== "object") return user;
  for (const [prop, desc] of Object.entries(LEGACY_ALIASES)) {
    try {
      const current = Object.getOwnPropertyDescriptor(user, prop);
      if (current && current.get && current.set) continue;
      if (current) delete user[prop];
      Object.defineProperty(user, prop, {
        configurable: true,
        enumerable: false,
        get: desc.get,
        set: desc.set,
      });
    } catch {
      /* ignore */
    }
  }
  return user;
}

class Database {
  constructor(dbPath) {
    this.dbPath = dbPath;
    this.stores = {};
    this.dirty = {
      users: false,
      groups: false,
      settings: false,
      stats: false,
      notes: false,
      filters: false,
      blacklists: false,
      registrations: false,
      federations: false,
      links: false,
      schedules: false,
      levels: false,
      whitelist: false,
      scopes: false,
      eventLogs: false,
    };
    this.db = {
      data: {
        users: {},
        groups: {},
        settings: {},
        stats: {},
        notes: {},
        filters: {},
        blacklists: {},
        registrations: {},
        federations: {},
        links: {},
        schedules: {},
        levels: {},
        whitelist: [],
        scopes: {},
        eventLogs: {},
      },
    };
    this.ready = false;
    this.flushTimer = null;
    this._writing = new Set();
    /** Bumped whenever the group registry (registration/alias) changes, so the
     *  alias resolver cache in `lib/group-registry.js` can invalidate itself. */
    this._registryVersion = 0;
    this.ensureDir();
  }

  ensureDir() {
    if (!fs.existsSync(this.dbPath)) {
      fs.mkdirSync(this.dbPath, { recursive: true });
    }
  }

  async init() {
    const { LowSync } = await import("lowdb");
    const { JSONFileSync } = await import("lowdb/node");

    const fileMap = {
      users: "users.json",
      groups: "groups.json",
      settings: "settings.json",
      stats: "stats.json",
      notes: "notes.json",
      filters: "filters.json",
      blacklists: "blacklists.json",
      registrations: "registrations.json",
      federations: "federations.json",
      links: "links.json",
      schedules: "schedules.json",
      levels: "levels.json",
      whitelist: "whitelist.json",
      scopes: "scopes.json",
      eventLogs: "eventLogs.json",
    };

    for (const [key, file] of Object.entries(fileMap)) {
      const filePath = path.join(this.dbPath, file);
      const defaults = DEFAULTS[key];
      this.validateJsonFile(filePath, defaults, file);

      const adapter = new JSONFileSync(filePath);
      const store = new LowSync(adapter, defaults);
      store.read();
      if (!store.data) store.data = defaults;
      if (typeof defaults === "object" && !Array.isArray(defaults)) {
        store.data = { ...defaults, ...store.data };
      }
      store.write();
      this.stores[key] = store;
    }

    this.db.data = {
      users: this.stores.users.data,
      groups: this.stores.groups.data,
      settings: this.stores.settings.data,
      stats: this.stores.stats.data,
      notes: this.stores.notes.data,
      filters: this.stores.filters.data,
      blacklists: this.stores.blacklists.data,
      registrations: this.stores.registrations.data,
      federations: this.stores.federations.data,
      links: this.stores.links.data,
      schedules: this.stores.schedules.data,
      levels: this.stores.levels.data,
      whitelist: this.stores.whitelist.data,
      scopes: this.stores.scopes.data,
      eventLogs: this.stores.eventLogs.data,
      /* in-memory namespaces read by the GX-ID compatibility layer (not persisted) */
      sewa: { enabled: false, groups: {} },
      premium: [],
      owner: [],
      partner: [],
      legacy: { clans: {}, sider: {}, antipm: {}, autopost: {}, activeWars: {}, pendingWars: {}, warHistory: [] },
      autoai: {},
    };

    this.startFlushTimer();
    this.registerShutdownHooks();
    this.ready = true;

    logger.database(`ready — ${path.relative(process.cwd(), this.dbPath)} (autosave ${FLUSH_INTERVAL_MS / 1000}s)`);
    return this;
  }

  startFlushTimer() {
    if (this.flushTimer) clearInterval(this.flushTimer);
    this.flushTimer = setInterval(() => this.flushDirty(), FLUSH_INTERVAL_MS);
    if (this.flushTimer.unref) this.flushTimer.unref();
  }

  registerShutdownHooks() {
    const flush = () => {
      try {
        this.flushAll();
      } catch {
        /* ignore */
      }
    };
    process.on("exit", flush);
    process.on("beforeExit", flush);
  }

  markDirty(key) {
    if (key in this.dirty) this.dirty[key] = true;
  }

  flushDirty() {
    for (const key of Object.keys(this.dirty)) {
      if (this.dirty[key] && this.stores[key]) {
        this._asyncWrite(key).catch(() => {});
      }
    }
  }

  async _asyncWrite(key) {
    if (!this.stores[key]) return;
    if (this._writing.has(key)) return;
    this._writing.add(key);
    try {
      const filePath =
        this.stores[key].adapter?.filename || path.join(this.dbPath, `${key}.json`);
      const json = JSON.stringify(this.stores[key].data, null, 2);
      const temp = `${filePath}.tmp`;
      await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
      await fs.promises.writeFile(temp, json, "utf-8");
      await fs.promises.rename(temp, filePath);
      this.dirty[key] = false;
    } catch (e) {
      logger.error(`write ${key} failed: ${e.message}`);
    }
    this._writing.delete(key);
  }

  flushAll() {
    for (const key of Object.keys(this.stores)) {
      try {
        this.stores[key].write();
        this.dirty[key] = false;
      } catch {
        /* ignore */
      }
    }
  }

  readAll() {
    for (const store of Object.values(this.stores)) {
      try {
        store.read();
      } catch {
        /* ignore */
      }
    }
  }

  validateJsonFile(filePath, defaults, fileName) {
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, JSON.stringify(defaults, null, 2), "utf-8");
      return;
    }
    const content = fs.readFileSync(filePath, "utf-8").trim();
    if (!content || content === "{}") {
      fs.writeFileSync(filePath, JSON.stringify(defaults, null, 2), "utf-8");
      return;
    }
    try {
      JSON.parse(content);
    } catch {
      const backup = path.join(this.dbPath, `${fileName}.corrupted.${Date.now()}.bak`);
      fs.copyFileSync(filePath, backup);
      fs.writeFileSync(filePath, JSON.stringify(defaults, null, 2), "utf-8");
      logger.warn(`${fileName} corrupt — backup at ${path.basename(backup)}`);
    }
  }

  async save() {
    try {
      this.flushAll();
      return true;
    } catch (e) {
      logger.error(`save failed: ${e.message}`);
      return false;
    }
  }

  /* ───────────── users ───────────── */

  getUser(jid) {
    if (!jid) return null;
    const key = String(jid).split("@")[0].split(":")[0];
    if (!key || key.startsWith("120")) return null;
    const user = this.db.data.users[key];
    return user ? applyLegacyAliases(user) : null;
  }

  setUser(jid, data = {}) {
    if (!jid) return null;
    const key = String(jid).split("@")[0].split(":")[0];
    if (!key || key.startsWith("120")) return null;
    const existing = this.db.data.users[key] || {};

    /* map legacy GX aliases (limit/money/balance/premium) onto the canonical
       fields so plugins written against GX-ID keep working unchanged */
    const existingEnergi =
      existing.energi !== undefined
        ? existing.energi
        : existing.limit !== undefined
          ? existing.limit
          : config.energi?.default ?? 25;
    const existingKoin =
      existing.koin !== undefined
        ? existing.koin
        : existing.money !== undefined
          ? existing.money
          : existing.balance !== undefined
            ? existing.balance
            : 0;
    const existingSaldo = existing.saldo !== undefined ? existing.saldo : 0;

    const record = {
      ...existing,
      ...data,
      jid: key,
      name: data.name || existing.name || "Unknown",
      number: key,
      isPremium: data.isPremium ?? existing.isPremium ?? false,
      isBanned: data.isBanned ?? existing.isBanned ?? false,
      exp: data.exp ?? existing.exp ?? 0,
      level: data.level ?? existing.level ?? 1,
      energi:
        data.energi ?? data.limit ?? existingEnergi,
      koin:
        data.koin ?? data.money ?? data.balance ?? existingKoin,
      saldo: data.saldo ?? existingSaldo,
      isRegistered: data.isRegistered ?? existing.isRegistered ?? false,
      rpg: { ...(existing.rpg || {}), ...(data.rpg || {}) },
      inventory: { ...(existing.inventory || {}), ...(data.inventory || {}) },
      cooldowns: data.cooldowns ?? existing.cooldowns ?? {},
      lastSeen: new Date().toISOString(),
    };
    delete record.limit;
    delete record.money;
    delete record.balance;

    this.db.data.users[key] = record;
    applyLegacyAliases(record);
    this.markDirty("users");
    return record;
  }

  deleteUser(jid) {
    const key = String(jid || "").split("@")[0].split(":")[0];
    if (this.db.data.users[key]) {
      delete this.db.data.users[key];
      this.markDirty("users");
      return true;
    }
    return false;
  }

  getAllUsers() {
    return this.db.data.users || {};
  }

  getUserCount() {
    return Object.keys(this.db.data.users || {}).length;
  }

  updateExp(jid, amount) {
    const user = this.getUser(jid) || this.setUser(jid);
    if (!user) return 0;
    const MAX_EXP = 9000000000;
    user.exp = Math.max(0, Math.min(MAX_EXP, (user.exp ?? 0) + amount));
    this.setUser(jid, user);
    return user.exp;
  }

  /* ───────────── GX-ID compatibility (energi / koin / saldo) ───────────── */

  /**
   * Adjust a user's `energi` (the GX "limit"). `-1` marks an unlimited
   * account (owner/premium when configured that way) and is preserved.
   */
  updateEnergi(jid, amount) {
    const user = this.getUser(jid) || this.setUser(jid);
    if (!user) return 0;
    if (user.energi === -1) return -1;

    try {
      const ownerEnergi = config.energi?.owner ?? -1;
      const premiumEnergi = config.energi?.premium ?? -1;
      if (config.isOwner?.(jid) && ownerEnergi === -1) return -1;
      if (config.isPremium?.(jid) && premiumEnergi === -1) return -1;
    } catch {
      /* config helper unavailable */
    }

    user.energi = Math.max(0, (user.energi ?? 0) + amount);
    this.setUser(jid, user);
    return user.energi;
  }

  /** Adjust a user's `koin` (GX "money"/"balance"). Capped for safety. */
  updateKoin(jid, amount) {
    const user = this.getUser(jid) || this.setUser(jid);
    if (!user) return 0;
    if (user.koin === -1) return -1;
    const MAX_KOIN = 9000000000000;
    user.koin = Math.max(0, Math.min(MAX_KOIN, (user.koin ?? 0) + amount));
    this.setUser(jid, user);
    return user.koin;
  }

  /** Adjust a user's `saldo` (real-currency-ish wallet). */
  updateSaldo(jid, amount) {
    const user = this.getUser(jid) || this.setUser(jid);
    if (!user) return 0;
    user.saldo = Math.max(0, (user.saldo ?? 0) + amount);
    this.setUser(jid, user);
    return user.saldo;
  }

  /** Return the top `limit` users by the given numeric field. */
  getTopUsers(field, limit = 10) {
    const users = Object.values(this.db.data.users || {});
    return users
      .filter((u) => (u[field] || 0) > 0)
      .sort((a, b) => (b[field] || 0) - (a[field] || 0))
      .slice(0, limit);
  }

  /** Reset every user's energi (GX daily scheduler). */
  resetAllEnergi(defaultEnergi = 25, premiumEnergi = -1) {
    let count = 0;
    for (const jid of Object.keys(this.db.data.users || {})) {
      const user = this.db.data.users[jid];
      user.energi = user.isPremium ? premiumEnergi : defaultEnergi;
      count++;
    }
    this.markDirty("users");
    return count;
  }

  /** Fill in the legacy RPG fields GX expects on a user record. */
  prepareLegacyUser(jid) {
    const user = this.getUser(jid) || this.setUser(jid, {});
    if (!user) return null;
    user.exp ??= 0;
    user.level ??= 1;
    user.health ??= 100;
    user.maxHealth ??= 100;
    user.warn ??= 0;
    user.bank ??= 0;
    user.premiumTime ??= 0;
    user.isRegistered ??= false;
    this.markDirty("users");
    return user;
  }

  /* ───────────── cooldowns ───────────── */

  checkCooldown(jid, command, seconds) {
    let user = this.getUser(jid) || this.setUser(jid, { cooldowns: {} });
    if (!user) return false;
    if (!user.cooldowns || typeof user.cooldowns !== "object") user.cooldowns = {};
    const end = user.cooldowns[command] || 0;
    const now = Date.now();
    if (now < end) return Math.ceil((end - now) / 1000);
    return false;
  }

  setCooldown(jid, command, seconds) {
    let user = this.getUser(jid) || this.setUser(jid, { cooldowns: {} });
    if (!user) return;
    if (!user.cooldowns || typeof user.cooldowns !== "object") user.cooldowns = {};
    user.cooldowns[command] = Date.now() + seconds * 1000;
    this.setUser(jid, { cooldowns: user.cooldowns });
  }

  /* ───────────── groups ───────────── */

  getGroup(jid) {
    if (!jid) return null;
    return this.db.data.groups[jid] || null;
  }

  setGroup(jid, data = {}) {
    if (!jid) return null;
    const existing = this.db.data.groups[jid] || {};
    this.db.data.groups[jid] = {
      ...existing,
      ...data,
      jid,
      name: data.name || existing.name || "Unknown Group",
      antilink: data.antilink ?? existing.antilink ?? false,
      mute: data.mute ?? existing.mute ?? false,
      welcome: data.welcome ?? existing.welcome ?? false,
      goodbye: data.goodbye ?? existing.goodbye ?? false,
    };
    this.markDirty("groups");
    return this.db.data.groups[jid];
  }

  getAllGroups() {
    return this.db.data.groups || {};
  }

  /* ───────────── notes (group-scoped) ───────────── */

  getNote(chatId, name) {
    if (!chatId || !name) return null;
    const key = String(name).toLowerCase().trim();
    return this.db.data.notes[chatId]?.[key] || null;
  }

  setNote(chatId, name, content, savedBy = null) {
    if (!chatId || !name) return null;
    const key = String(name).toLowerCase().trim();
    if (!this.db.data.notes[chatId]) this.db.data.notes[chatId] = {};
    this.db.data.notes[chatId][key] = {
      name: key,
      content,
      savedBy,
      updatedAt: new Date().toISOString(),
    };
    this.markDirty("notes");
    return this.db.data.notes[chatId][key];
  }

  deleteNote(chatId, name) {
    const key = String(name || "").toLowerCase().trim();
    if (this.db.data.notes[chatId]?.[key]) {
      delete this.db.data.notes[chatId][key];
      this.markDirty("notes");
      return true;
    }
    return false;
  }

  listNotes(chatId) {
    if (!chatId) return [];
    return Object.values(this.db.data.notes[chatId] || {});
  }

  /* ───────────── notes (rich: text + media, created_by) ─────────────
   * The rich note store lives in the same `notes` namespace as the legacy
   * `setNote`/`getNote` API, but records carry optional media fields. Rich
   * records are recognised by the presence of a `createdAt` ISO timestamp.
   */

  setRichNote(chatId, name, data = {}) {
    if (!chatId || !name) return null;
    const key = String(name).toLowerCase().trim();
    if (!this.db.data.notes[chatId]) this.db.data.notes[chatId] = {};
    const existing = this.db.data.notes[chatId][key] || {};
    this.db.data.notes[chatId][key] = {
      name: key,
      content: data.content ?? existing.content ?? "",
      mediaType: data.mediaType ?? existing.mediaType ?? null,
      mediaBase64: data.mediaBase64 ?? existing.mediaBase64 ?? null,
      mediaMimetype: data.mediaMimetype ?? existing.mediaMimetype ?? null,
      createdBy: data.createdBy ?? existing.createdBy ?? null,
      createdAt: existing.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.markDirty("notes");
    return this.db.data.notes[chatId][key];
  }

  /* ───────────── filters (group auto-reply triggers) ───────────── */

  setFilter(scopeId, trigger, data = {}) {
    if (!scopeId || !trigger) return null;
    const key = normalizeEntry(trigger);
    if (!this.db.data.filters[scopeId]) this.db.data.filters[scopeId] = {};
    const existing = this.db.data.filters[scopeId][key] || {};
    this.db.data.filters[scopeId][key] = {
      trigger: key,
      content: data.content ?? existing.content ?? "",
      mediaType: data.mediaType ?? existing.mediaType ?? null,
      mediaBase64: data.mediaBase64 ?? existing.mediaBase64 ?? null,
      mediaMimetype: data.mediaMimetype ?? existing.mediaMimetype ?? null,
      createdBy: data.createdBy ?? existing.createdBy ?? null,
      createdAt: existing.createdAt || new Date().toISOString(),
    };
    this.markDirty("filters");
    return this.db.data.filters[scopeId][key];
  }

  getFilter(scopeId, trigger) {
    if (!scopeId || !trigger) return null;
    return this.db.data.filters[scopeId]?.[normalizeEntry(trigger)] || null;
  }

  deleteFilter(scopeId, trigger) {
    const key = normalizeEntry(trigger);
    if (this.db.data.filters[scopeId]?.[key]) {
      delete this.db.data.filters[scopeId][key];
      this.markDirty("filters");
      return true;
    }
    return false;
  }

  listFilters(scopeId) {
    if (!scopeId) return [];
    return Object.values(this.db.data.filters[scopeId] || {});
  }

  /* ───────────── blacklists (group word/phrase filters) ───────────── */

  addBlacklist(scopeId, entry, addedBy = null) {
    if (!scopeId || !entry) return null;
    const key = normalizeEntry(entry);
    if (!this.db.data.blacklists[scopeId]) this.db.data.blacklists[scopeId] = {};
    if (this.db.data.blacklists[scopeId][key]) return this.db.data.blacklists[scopeId][key];
    this.db.data.blacklists[scopeId][key] = {
      entry: key,
      addedBy,
      createdAt: new Date().toISOString(),
    };
    this.markDirty("blacklists");
    return this.db.data.blacklists[scopeId][key];
  }

  removeBlacklist(scopeId, entry) {
    const key = normalizeEntry(entry);
    if (this.db.data.blacklists[scopeId]?.[key]) {
      delete this.db.data.blacklists[scopeId][key];
      this.markDirty("blacklists");
      return true;
    }
    return false;
  }

  listBlacklist(scopeId) {
    if (!scopeId) return [];
    return Object.values(this.db.data.blacklists[scopeId] || {});
  }

  /* ───────────── registrations (group registry) ───────────── */

  /** Version counter for the registry, used to invalidate the alias cache. */
  registryVersion() {
    return this._registryVersion || 0;
  }

  _bumpRegistry() {
    this._registryVersion = (this._registryVersion || 0) + 1;
  }

  registerGroup(jid, data = {}) {
    if (!jid) return null;
    const existing = this.db.data.registrations[jid] || {};
    this.db.data.registrations[jid] = {
      ...existing,
      jid,
      name: data.name ?? existing.name ?? "",
      alias: data.alias !== undefined ? data.alias : existing.alias ?? null,
      aliases: Array.isArray(data.aliases) ? data.aliases : existing.aliases || [],
      registeredBy: data.registeredBy ?? existing.registeredBy ?? null,
      registeredAt: existing.registeredAt || new Date().toISOString(),
      status: data.status ?? existing.status ?? "active",
      activated: data.activated ?? existing.activated ?? true,
      logPanel: data.logPanel !== undefined ? data.logPanel : existing.logPanel ?? null,
    };
    this.markDirty("registrations");
    this._bumpRegistry();
    return this.db.data.registrations[jid];
  }

  getRegistration(jid) {
    if (!jid) return null;
    return this.db.data.registrations[jid] || null;
  }

  /** Persist a group's canonical alias. Returns the updated record or null. */
  setRegistrationAlias(jid, alias) {
    const reg = this.db.data.registrations[jid];
    if (!reg) return null;
    reg.alias = alias || null;
    this.markDirty("registrations");
    this._bumpRegistry();
    return reg;
  }

  /** Persist the moderation-log panel target for a registered group. */
  setRegistrationLogPanel(jid, panelJid) {
    const reg = this.db.data.registrations[jid];
    if (!reg) return null;
    reg.logPanel = panelJid || null;
    this.markDirty("registrations");
    return reg;
  }

  unregisterGroup(jid) {
    if (this.db.data.registrations[jid]) {
      delete this.db.data.registrations[jid];
      this.markDirty("registrations");
      this._bumpRegistry();
      return true;
    }
    return false;
  }

  listRegistrations() {
    return Object.values(this.db.data.registrations || {});
  }

  /* ───────────── feature scopes (shared notes / filters / blacklists) ───────────── */

  /** The scope a feature uses for `jid`, or null when it is not shared. */
  findScopeFor(feature, jid) {
    if (!feature || !jid) return null;
    const f = String(feature).toLowerCase();
    for (const scope of Object.values(this.db.data.scopes || {})) {
      if (scope.feature === f && scope.groups.includes(jid)) return scope;
    }
    return null;
  }

  getScope(id) {
    if (!id) return null;
    return this.db.data.scopes[id] || null;
  }

  createScope(feature, groups) {
    const f = String(feature || "").toLowerCase();
    const list = [...new Set(groups.filter(Boolean))];
    if (!f || list.length < 2) return null;
    const id = `sc_${f}_${String(list[0]).split("@")[0]}_${Date.now().toString(36)}`;
    this.db.data.scopes[id] = {
      id,
      feature: f,
      groups: list,
      createdAt: new Date().toISOString(),
    };
    this.markDirty("scopes");
    return this.db.data.scopes[id];
  }

  /** Merge `jid` into `scopeId`, absorbing any scope `jid` already had. */
  addGroupToScope(scopeId, jid) {
    const scope = this.db.data.scopes[scopeId];
    if (!scope || !jid) return null;
    // Absorb any existing scope of the same feature that already contains jid.
    for (const [id, other] of Object.entries(this.db.data.scopes)) {
      if (id === scopeId || other.feature !== scope.feature) continue;
      if (other.groups.includes(jid)) {
        for (const g of other.groups) if (!scope.groups.includes(g)) scope.groups.push(g);
        delete this.db.data.scopes[id];
      }
    }
    if (!scope.groups.includes(jid)) scope.groups.push(jid);
    this.markDirty("scopes");
    return scope;
  }

  removeGroupFromScope(scopeId, jid) {
    const scope = this.db.data.scopes[scopeId];
    if (!scope) return false;
    const before = scope.groups.length;
    scope.groups = scope.groups.filter((g) => g !== jid);
    // A scope with a single member is no longer "shared" — dissolve it.
    if (scope.groups.length < 2) {
      delete this.db.data.scopes[scopeId];
    }
    if (scope.groups.length !== before) {
      this.markDirty("scopes");
      return true;
    }
    return false;
  }

  listScopes(feature = null) {
    const all = Object.values(this.db.data.scopes || {});
    return feature ? all.filter((s) => s.feature === String(feature).toLowerCase()) : all;
  }

  /* ───────────── event logs (moderation / message events) ───────────── */

  addEventLog(entry) {
    if (!entry?.id) return null;
    this.db.data.eventLogs[entry.id] = entry;
    this.markDirty("eventLogs");
    return entry;
  }

  listEventLogs(limit = 50, filter = {}) {
    let all = Object.values(this.db.data.eventLogs || {});
    if (filter.groupId) all = all.filter((e) => e.groupId === filter.groupId);
    if (filter.type) all = all.filter((e) => e.type === filter.type);
    all.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
    return limit ? all.slice(0, limit) : all;
  }

  pruneEventLogs(beforeIso) {
    let removed = 0;
    for (const [id, entry] of Object.entries(this.db.data.eventLogs || {})) {
      if (String(entry.createdAt || "") < beforeIso) {
        delete this.db.data.eventLogs[id];
        removed++;
      }
    }
    if (removed) this.markDirty("eventLogs");
    return removed;
  }

  eventLogCount() {
    return Object.keys(this.db.data.eventLogs || {}).length;
  }

  /* ───────────── federations ───────────── */

  createFederation(name, id, alias) {
    if (!name || !id) return null;
    this.db.data.federations[id] = {
      id,
      name,
      alias: alias || id,
      groups: [],
      bans: [],
      createdAt: new Date().toISOString(),
    };
    this.markDirty("federations");
    return this.db.data.federations[id];
  }

  getFederation(id) {
    if (!id) return null;
    return this.db.data.federations[id] || null;
  }

  /** Persist a federation's short alias (must be unique across federations). */
  setFederationAlias(id, alias) {
    const fed = this.db.data.federations[id];
    if (!fed) return null;
    fed.alias = alias || fed.id;
    this.markDirty("federations");
    return fed;
  }

  /**
   * Resolve a user-supplied federation reference to its record. Matches, in
   * order: exact id, exact alias, exact name, then a case-insensitive id/alias/
   * name substring. This lets commands accept an id, an alias, or the display
   * name interchangeably.
   */
  findFederation(query) {
    const q = String(query || "").trim().toLowerCase();
    if (!q) return null;
    const feds = Object.values(this.db.data.federations || {});
    return (
      feds.find((f) => String(f.id).toLowerCase() === q) ||
      feds.find((f) => String(f.alias || "").toLowerCase() === q) ||
      feds.find((f) => String(f.name || "").toLowerCase() === q) ||
      feds.find((f) => String(f.id).toLowerCase().includes(q)) ||
      feds.find((f) => String(f.alias || "").toLowerCase().includes(q)) ||
      feds.find((f) => String(f.name || "").toLowerCase().includes(q)) ||
      null
    );
  }

  /** Record a number as banned across a federation (idempotent). */
  addFederationBan(id, jid) {
    const fed = this.db.data.federations[id];
    if (!fed) return null;
    if (!Array.isArray(fed.bans)) fed.bans = [];
    const number = String(jid || "").split("@")[0].split(":")[0].replace(/[^0-9]/g, "");
    if (number && !fed.bans.includes(number)) {
      fed.bans.push(number);
      this.markDirty("federations");
    }
    return fed.bans;
  }

  /** Remove a number from a federation's ban list. Returns the updated list. */
  removeFederationBan(id, jid) {
    const fed = this.db.data.federations[id];
    if (!fed) return null;
    const number = String(jid || "").split("@")[0].split(":")[0].replace(/[^0-9]/g, "");
    const before = (fed.bans || []).length;
    fed.bans = (fed.bans || []).filter((b) => b !== number);
    if (fed.bans.length !== before) this.markDirty("federations");
    return fed.bans;
  }

  /** The numbers banned across a federation. */
  listFederationBans(id) {
    const fed = this.db.data.federations[id];
    return fed && Array.isArray(fed.bans) ? [...fed.bans] : [];
  }

  joinFederation(id, jid) {
    const fed = this.db.data.federations[id];
    if (!fed) return null;
    if (!Array.isArray(fed.groups)) fed.groups = [];
    if (!fed.groups.includes(jid)) fed.groups.push(jid);
    this.markDirty("federations");
    return fed;
  }

  leaveFederation(id, jid) {
    const fed = this.db.data.federations[id];
    if (!fed) return null;
    fed.groups = (fed.groups || []).filter((g) => g !== jid);
    this.markDirty("federations");
    return fed;
  }

  listFederations() {
    return Object.values(this.db.data.federations || {});
  }

  /* ───────────── cross-group links (management → targets) ───────────── */

  linkGroup(managementJid, targetJid) {
    if (!managementJid || !targetJid) return false;
    if (!this.db.data.links[managementJid]) this.db.data.links[managementJid] = [];
    if (!this.db.data.links[managementJid].includes(targetJid)) {
      this.db.data.links[managementJid].push(targetJid);
      this.markDirty("links");
    }
    return true;
  }

  unlinkGroup(managementJid, targetJid) {
    if (!this.db.data.links[managementJid]) return false;
    const before = this.db.data.links[managementJid].length;
    this.db.data.links[managementJid] = this.db.data.links[managementJid].filter((g) => g !== targetJid);
    if (this.db.data.links[managementJid].length !== before) {
      this.markDirty("links");
      return true;
    }
    return false;
  }

  isLinked(managementJid, targetJid) {
    return !!this.db.data.links[managementJid]?.includes(targetJid);
  }

  getLinks(managementJid) {
    return [...(this.db.data.links[managementJid] || [])];
  }

  /** Every management chat that has `targetJid` linked (used by report/moderation fan-out). */
  getManagementGroupsForTarget(targetJid) {
    const out = [];
    for (const [managementJid, targets] of Object.entries(this.db.data.links || {})) {
      if (targets.includes(targetJid)) out.push(managementJid);
    }
    return out;
  }

  /* ───────────── schedules (persistent) ───────────── */

  createSchedule(id, data = {}) {
    if (!id) return null;
    this.db.data.schedules[id] = {
      id,
      jid: data.jid,
      content: data.content ?? "",
      mediaType: data.mediaType ?? null,
      mediaBase64: data.mediaBase64 ?? null,
      mediaMimetype: data.mediaMimetype ?? null,
      sendTime: data.sendTime,
      recurrence: data.recurrence,
      recurrenceValue: data.recurrenceValue ?? null,
      createdBy: data.createdBy ?? null,
      createdAt: new Date().toISOString(),
      lastSentAt: null,
      active: true,
    };
    this.markDirty("schedules");
    return this.db.data.schedules[id];
  }

  getSchedule(id) {
    if (!id) return null;
    return this.db.data.schedules[id] || null;
  }

  listSchedules(jid = null) {
    const all = Object.values(this.db.data.schedules || {});
    return jid ? all.filter((s) => s.jid === jid) : all;
  }

  deleteSchedule(id) {
    if (this.db.data.schedules[id]) {
      delete this.db.data.schedules[id];
      this.markDirty("schedules");
      return true;
    }
    return false;
  }

  updateSchedule(id, data = {}) {
    if (!this.db.data.schedules[id]) return null;
    this.db.data.schedules[id] = { ...this.db.data.schedules[id], ...data };
    this.markDirty("schedules");
    return this.db.data.schedules[id];
  }

  /* ───────────── levels (per group+user XP) ───────────── */

  addLevelXp(jid, groupId, amount) {
    if (!jid || !groupId) return null;
    if (!this.db.data.levels[groupId]) this.db.data.levels[groupId] = {};
    const key = String(jid).split("@")[0].split(":")[0];
    const rec = this.db.data.levels[groupId][key] || {
      jid: key,
      xp: 0,
      level: 1,
      messageCount: 0,
      updatedAt: null,
    };
    rec.xp = Math.max(0, (rec.xp || 0) + amount);
    rec.messageCount = (rec.messageCount || 0) + 1;
    rec.level = Math.max(1, Math.floor(Math.sqrt(rec.xp / 100)) + 1);
    rec.updatedAt = new Date().toISOString();
    this.db.data.levels[groupId][key] = rec;
    this.markDirty("levels");
    return rec;
  }

  getLevel(jid, groupId) {
    if (!jid || !groupId) return null;
    const key = String(jid).split("@")[0].split(":")[0];
    return this.db.data.levels[groupId]?.[key] || null;
  }

  getTopLevels(groupId, limit = 10) {
    if (!groupId) return [];
    return Object.values(this.db.data.levels[groupId] || {})
      .sort((a, b) => (b.xp || 0) - (a.xp || 0))
      .slice(0, limit);
  }

  resetLevels(groupId) {
    if (!groupId) return 0;
    const count = Object.keys(this.db.data.levels[groupId] || {}).length;
    this.db.data.levels[groupId] = {};
    this.markDirty("levels");
    return count;
  }

  /** Reset one member's XP in a group (or the whole group when `jid` is null). */
  resetLevel(jid, groupId) {
    if (!groupId) return 0;
    if (!jid) return this.resetLevels(groupId);
    const key = String(jid).split("@")[0].split(":")[0];
    if (this.db.data.levels[groupId]?.[key]) {
      delete this.db.data.levels[groupId][key];
      this.markDirty("levels");
      return 1;
    }
    return 0;
  }

  /* ───────────── whitelist (global access tier) ───────────── */

  addWhitelist(number, addedBy = null) {
    const num = String(number || "").replace(/[^0-9]/g, "");
    if (!num) return false;
    if (!Array.isArray(this.db.data.whitelist)) this.db.data.whitelist = [];
    if (this.db.data.whitelist.some((w) => String(w.number) === num)) return false;
    this.db.data.whitelist.push({ number: num, addedBy, createdAt: new Date().toISOString() });
    this.markDirty("whitelist");
    return true;
  }

  removeWhitelist(number) {
    const num = String(number || "").replace(/[^0-9]/g, "");
    if (!Array.isArray(this.db.data.whitelist)) return false;
    const before = this.db.data.whitelist.length;
    this.db.data.whitelist = this.db.data.whitelist.filter((w) => String(w.number) !== num);
    if (this.db.data.whitelist.length !== before) {
      this.markDirty("whitelist");
      return true;
    }
    return false;
  }

  listWhitelist() {
    return Array.isArray(this.db.data.whitelist) ? [...this.db.data.whitelist] : [];
  }

  isWhitelisted(number) {
    const num = String(number || "").replace(/[^0-9]/g, "");
    if (!num) return false;
    return this.listWhitelist().some((w) => String(w.number) === num);
  }

  /* ───────────── settings / stats ───────────── */

  setting(key, value = undefined) {
    if (value !== undefined) {
      this.db.data.settings[key] = value;
      this.markDirty("settings");
    }
    return this.db.data.settings[key];
  }

  getSettings() {
    return this.db.data.settings || {};
  }

  incrementStat(key, increment = 1) {
    if (!this.db.data.stats[key]) this.db.data.stats[key] = 0;
    this.db.data.stats[key] += increment;
    this.markDirty("stats");
    return this.db.data.stats[key];
  }

  getStats(key) {
    if (key) return this.db.data.stats[key] || 0;
    return this.db.data.stats || {};
  }

  backup() {
    this.flushAll();
    const backupDir = path.join(this.dbPath, "backups");
    if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const backupPath = path.join(backupDir, `backup-${ts}.json`);
    fs.writeFileSync(backupPath, JSON.stringify(this.db.data, null, 2), "utf-8");
    return backupPath;
  }

  get data() {
    return this.db.data;
  }
}

let dbInstance = null;

export async function initDatabase(dbPath) {
  if (!dbInstance) {
    dbInstance = new Database(dbPath);
    await dbInstance.init();
  }
  return dbInstance;
}

export function getDatabase() {
  if (!dbInstance) throw new Error("Database not initialized. Call initDatabase first.");
  return dbInstance;
}

export { Database };
