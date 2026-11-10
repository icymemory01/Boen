/**
 * consent.ts —— 监护人同意（不满 14 周岁）
 *
 * 《个人信息保护法》第 31 条要求：处理不满 14 周岁未成年人个人信息，
 * 应当取得父母或其他监护人的同意，并制定专门的处理规则。
 *
 * 本项目把「小学 1–6 年级」视为可能不满 14 周岁的群体：
 * - 这类用户首次使用前必须提交一次监护人同意记录；
 * - 记录与版本号绑定，条款更新后可要求重新同意；
 * - 未同意的用户，聊天等涉及个人信息的入口会被拦下（返回 403 + 明确文案）。
 */
import db from './db.js';

/** 监护人同意条款版本；条款更新时递增，用户需要重新同意 */
export const GUARDIAN_CONSENT_VERSION = '2026-11-10';

export interface GuardianConsent {
  userId: string;
  guardianName: string;
  relationship: string;
  consentVersion: string;
  agreedAt: number;
}

interface ConsentRow {
  user_id: string;
  guardian_name: string;
  relationship: string;
  consent_version: string;
  agreed_at: number;
  revoked_at: number | null;
}

/** 是否已完成当前版本的监护人同意 */
export function hasGuardianConsent(userId: string): boolean {
  const row = db.prepare(`SELECT consent_version, revoked_at FROM guardian_consents WHERE user_id=?`)
    .get(userId) as { consent_version: string; revoked_at: number | null } | undefined;
  if (!row) return false;
  if (row.revoked_at) return false;
  return row.consent_version === GUARDIAN_CONSENT_VERSION;
}

/** 读取同意记录（含已撤销的） */
export function getGuardianConsent(userId: string): GuardianConsent | null {
  const row = db.prepare(`SELECT * FROM guardian_consents WHERE user_id=?`).get(userId) as ConsentRow | undefined;
  if (!row) return null;
  return {
    userId: row.user_id,
    guardianName: row.guardian_name,
    relationship: row.relationship,
    consentVersion: row.consent_version,
    agreedAt: row.agreed_at,
  };
}

/**
 * 记录监护人同意（覆盖式写入）。
 * @param guardianName 监护人姓名（可为空，但要留痕）
 * @param relationship 与学生的关系（父/母/其他监护人）
 */
export function recordGuardianConsent(
  userId: string,
  params: { guardianName?: string; relationship?: string; ip?: string } = {},
): GuardianConsent {
  db.prepare(`
    INSERT INTO guardian_consents (user_id, guardian_name, relationship, consent_version, agreed_at, ip, revoked_at)
    VALUES (?, ?, ?, ?, unixepoch(), ?, NULL)
    ON CONFLICT(user_id) DO UPDATE SET
      guardian_name=excluded.guardian_name,
      relationship=excluded.relationship,
      consent_version=excluded.consent_version,
      agreed_at=excluded.agreed_at,
      ip=excluded.ip,
      revoked_at=NULL
  `).run(
    userId,
    (params.guardianName ?? '').slice(0, 40),
    (params.relationship ?? '').slice(0, 20),
    GUARDIAN_CONSENT_VERSION,
    params.ip ?? null,
  );
  const consent = getGuardianConsent(userId);
  if (!consent) throw new Error('监护人同意写入失败');
  return consent;
}

/** 撤销同意（家长可随时撤回；撤销后需重新同意才能继续使用） */
export function revokeGuardianConsent(userId: string): boolean {
  const r = db.prepare(`UPDATE guardian_consents SET revoked_at=unixepoch() WHERE user_id=? AND revoked_at IS NULL`)
    .run(userId);
  return r.changes > 0;
}

/**
 * 是否需要监护人同意才能使用：由调用方传入用户年级。
 * 小学 1–6 年级按「可能不满 14 周岁」处理。
 */
export function requiresConsentFor(grade?: string): boolean {
  const n = Number(grade);
  if (!Number.isFinite(n)) return false;
  return n >= 1 && n <= 6;
}
