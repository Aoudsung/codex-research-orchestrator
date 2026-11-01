import importlib.util
import json
import tempfile
import sqlite3
import unittest
from pathlib import Path
from unittest.mock import patch

SCRIPT=Path(__file__).resolve().parents[1]/'skills/codex-research-orchestrator/scripts/research_memory.py'
spec=importlib.util.spec_from_file_location('database_memory',SCRIPT)
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)

class DatabaseTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.root=Path(self.tmp.name);(self.root/'controls.md').write_text('Research only.')
        self.mem=m.Memory(self.root,['controls.md']);self.addCleanup(self.mem.close)
    def save(self,**kw):
        d=dict(kind='claim',title='有限样本偏差',summary='Gamma correction',scope='Gaussian only',body='完整推导 Γ，偏差必须控制。',author='codex')
        d.update(kw);return self.mem.save(d)
    def test_no_files_short_cjk_alias_and_history(self):
        row=self.save(aliases=['继承信用'],external_key='one')
        with patch.object(self.mem,'read_source',side_effect=AssertionError('no source read')):
            for q in ['偏差','Γ','有限样本','继承信用']:
                self.assertEqual(row['id'],self.mem.query(q)['results'][0]['id'])
            self.assertEqual(row['body'],self.mem.read(row['id'])['body'])
        archive=self.save(kind='source',state='historical',title='档案测试')
        self.assertFalse(self.mem.query('档案')['results'])
        self.assertEqual(archive['id'],self.mem.query('档案',include_history=True)['results'][0]['id'])
    def test_cas_idempotency_and_invalidation(self):
        old=self.save(object_key='formula',external_key='key')
        self.assertEqual(old['id'],self.save(object_key='formula',external_key='key')['id'])
        with self.assertRaises(m.MemoryError):self.save(body='different',external_key='key')
        child=self.save(depends_on=[old['id']],claim_status='derived')
        new=self.save(object_key='formula',expected_revision=1,reason='corrected',body='29/2')
        self.assertEqual(2,new['version'])
        with self.assertRaises(m.MemoryError):self.save(object_key='formula',expected_revision=1,reason='stale')
        self.assertEqual('needs_review',self.mem.record(child['id'])['state'])
        self.assertEqual('derived',self.mem.record(child['id'])['claim_status'])
    def test_context_counterevidence_and_isolation(self):
        evidence=self.save(kind='evidence',body='source only')
        proposal=self.save(kind='proposal',body='complete proposal')
        private=self.save(kind='evaluation',body='PRIVATE REVIEW',relations=[dict(type='refutes',target=proposal['id'])])
        packet=self.mem.database_context('proposal',required=[proposal['id']])
        self.assertIn('PRIVATE REVIEW',packet['text'])
        independent=self.mem.database_context('proposal',profile='review',target=proposal['id'],allow=[proposal['id'],evidence['id']])
        self.assertNotIn('PRIVATE',independent['text'])
        with self.assertRaises(m.MemoryError):self.mem.database_context('',required=[proposal['id']],max_chars=5)
    def test_paged_read_does_not_expose_internal_request_and_archives_are_admitted(self):
        row=self.save(kind='source',state='historical',body='secret-tail-which-must-not-escape')
        result=m.dispatch('read',self.root,{'id':row['id'],'offset':0,'limit':6})
        self.assertEqual('secret',result['body'])
        self.assertNotIn('request_json',result)
        self.assertNotIn('must-not-escape',json.dumps(result))
        for required in ([],[row['id']]):
            packet=self.mem.database_context('secret',profile='analysis',allow=[row['id']],required=required)
            self.assertIn('secret-tail-which-must-not-escape',packet['text'])

    def test_upgrade_ddl_rolls_back_on_interruption(self):
        legacy=self.root/'legacy';legacy.mkdir();(legacy/'controls.md').write_text('controls')
        with patch.object(m.Memory,'_upgrade_database',lambda self: None):
            initial=m.Memory(legacy,['controls.md']);initial.close()
        obj=m.Memory.__new__(m.Memory)
        obj.db=sqlite3.connect(legacy/'.research-memory/memory.sqlite3')
        obj.db.row_factory=sqlite3.Row
        count=0
        def authorizer(action,*args):
            nonlocal count
            if action==sqlite3.SQLITE_ALTER_TABLE:
                count+=1
                if count==2:return sqlite3.SQLITE_DENY
            return sqlite3.SQLITE_OK
        obj.db.set_authorizer(authorizer)
        with self.assertRaises(sqlite3.DatabaseError):obj._upgrade_database()
        obj.db.set_authorizer(None)
        self.assertNotIn('storage',{r[1] for r in obj.db.execute('PRAGMA table_info(records)')})
        obj.db.close()
        fixed=m.Memory(legacy)
        self.assertIn('object_key',{r[1] for r in fixed.db.execute('PRAGMA table_info(records)')})
        fixed.close()

    def test_export_is_one_snapshot_during_concurrent_write(self):
        first=self.save()
        self.mem.db.execute('PRAGMA journal_mode=WAL')
        writer=m.Memory(self.root)
        fired=False
        def trace(sql):
            nonlocal fired
            if sql=='SELECT * FROM config' and not fired:
                fired=True
                writer.save(dict(kind='claim',title='second',summary='second',scope='local',body='second',author='peer',depends_on=[first['id']]))
        self.mem.db.set_trace_callback(trace)
        try:dump=self.mem.export_data()['text']
        finally:self.mem.db.set_trace_callback(None);writer.close()
        entries=[json.loads(l) for l in dump.splitlines()]
        ids={e['row']['id'] for e in entries if e['table']=='records'}
        self.assertTrue(fired);self.assertEqual({first['id']},ids)
        for e in entries:
            if e['table']=='dependencies':self.assertIn(e['row']['record_id'],ids)

    def test_old_formula_follows_revision_and_labels_stale_evidence(self):
        old=self.save(object_key='formula',body='45/4')
        base=self.save(kind='source',object_key='observation',body='observation')
        evidence=self.save(kind='evidence',body='45/4 fails',depends_on=[base['id']],relations=[dict(type='refutes',target=old['id'])])
        new=self.save(object_key='formula',expected_revision=1,reason='corrected matrix moment',body='29/2')
        packet=self.mem.database_context('45/4')
        self.assertIn('29/2',packet['text']);self.assertIn('corrected matrix moment',packet['text']);self.assertIn('superseded',packet['text'])
        self.save(object_key='observation',expected_revision=1,reason='updated measurement')
        packet=self.mem.database_context('45/4')
        self.assertIn('needs_review',packet['text']);self.assertIn('Not usable as current evidence',packet['text'])
        self.assertTrue(any(r['id']==new['id'] for r in self.mem.query('45/4')['results']))

    def test_export_restore_and_backup(self):
        old=self.save(external_key='old')
        self.save(body='new',supersedes=old['id'],reason='fix',relations=[dict(type='limits',target=old['id'])])
        dump=self.mem.export_data()['text'];(self.root/'dump.jsonl').write_text(dump)
        m.dispatch('backup',self.root,{'output':'backup.sqlite3'})
        other=self.root/'other';other.mkdir();(other/'controls.md').write_text('Research only.');(other/'dump.jsonl').write_text(dump)
        m.dispatch('init',other,{'controls':['controls.md']})
        result=m.dispatch('restore',other,{'source':'dump.jsonl'})
        self.assertEqual(2,result['records'])
        restored=m.dispatch('read',other,{'id':2})
        self.assertEqual('new',restored['body']);self.assertEqual(old['id'],restored['relations'][0]['target'])

    def test_kv_cache_deterministic_anchor_prefix_stability(self):
        src=self.save(kind='source',title='Anchor Source',body='Authoritative anchor source text.')
        claim=self.save(kind='claim',title='Anchor Claim',body='Core claim depending on source.',depends_on=[src['id']])
        self.save(kind='evidence',title='Extra Alpha',body='alpha keyword supplemental observation')
        self.save(kind='evidence',title='Extra Beta',body='beta keyword supplemental observation')
        pkt_a=self.mem.database_context('alpha',required=[claim['id'],src['id']])
        pkt_b=self.mem.database_context('beta',required=[src['id'],claim['id']])
        prefix_len=pkt_a['manifest']['anchor_prefix_chars']
        self.assertEqual(prefix_len,pkt_b['manifest']['anchor_prefix_chars'])
        self.assertGreater(prefix_len,50)
        self.assertEqual(pkt_a['text'][:prefix_len],pkt_b['text'][:prefix_len])
        # Volatile 'Not shown: ...' footer is strictly at the tail
        self.assertNotIn('Not shown:',pkt_a['text'][:prefix_len])
        self.assertTrue(pkt_a['text'].rstrip().endswith('admitted records.'))

if __name__=='__main__':unittest.main()
