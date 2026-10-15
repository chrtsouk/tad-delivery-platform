import { q } from './db.js';

export function createAudit(db, now) {
  return {
    log(actor, action, entity = null, entityId = null, detail = null) {
      q.run(db, 'INSERT INTO audit_log(at,actor,action,entity,entity_id,detail) VALUES(?,?,?,?,?,?)',
        now().toISOString(), actor || 'system', action, entity, entityId == null ? null : String(entityId), detail ? JSON.stringify(detail) : null);
    },
    recent(limit = 200, { from, to } = {}) {
      const rows = q.all(db, `SELECT * FROM audit_log WHERE (?1 IS NULL OR at >= ?1) AND (?2 IS NULL OR at < ?2) ORDER BY id DESC LIMIT ?3`, from ?? null, to ?? null, limit);
      return rows.map((r) => ({ ...r, detail: r.detail ? JSON.parse(r.detail) : null }));
    },
  };
}
