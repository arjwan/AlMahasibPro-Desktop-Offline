// Only reconcile the known missing field. Never rebuild or replace ledger tables.
export function ensureJournalReference(db,{backupPath}={}){
 const columns=db.prepare('PRAGMA table_info(journal_entries)').all();
 if(!columns.length)throw Error('جدول القيود غير موجود؛ لا يمكن إصلاح قاعدة غير معروفة');
 if(columns.some(x=>x.name==='reference'))return {changed:false};
 if(backupPath)db.prepare('VACUUM INTO ?').run(backupPath);
 db.exec('BEGIN IMMEDIATE');try{
  if(!db.prepare('PRAGMA table_info(journal_entries)').all().some(x=>x.name==='reference'))db.exec('ALTER TABLE journal_entries ADD COLUMN reference TEXT');
  db.prepare('SELECT e.reference FROM journal_entries e LIMIT 0').all();
  db.exec('COMMIT');return {changed:true,backup:backupPath||null};
 }catch(e){db.exec('ROLLBACK');throw e}
}
