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

    def test_recipient_profiles_pro_macro_clutter_guard_and_gemini_panoramic(self):
        conceptual=self.save(kind='question',title='Core Paradox',body='Why does feedback loop collapse under non-stationary horizon?')
        code_clutter=self.save(kind='evidence',title='Code Dump',body=' collapse ```python\ndef step(x):\n    return x\n```')
        ledger_clutter=self.save(kind='decision',title='Ledger Dump',body='collapse\n- D1: use Adam\n- C1: bound holds')
        checkpoint=self.save(kind='checkpoint',title='Run Cursor',body='collapse cursor seq=42')
        extra_paper=self.save(kind='source',title='Unmatched Primary Paper',body='Complete primary ergodic control paper without query keyword.')

        pro_pkt=m.dispatch('context',self.root,{'query':'collapse','recipient_profile':'pro_macro'})
        self.assertEqual(6000,pro_pkt['manifest']['max_chars'])
        self.assertEqual([conceptual['id']],pro_pkt['manifest']['selected_ids'])
        self.assertCountEqual([code_clutter['id'],ledger_clutter['id'],checkpoint['id']],pro_pkt['manifest']['filtered_clutter_ids'])
        self.assertIn('Research context | resume | pro_macro',pro_pkt['text'])
        self.assertNotIn('```python',pro_pkt['text'])

        with self.assertRaises(m.MemoryError):
            self.mem.database_context('collapse',recipient_profile='pro_macro',max_chars=9000)
        with self.assertRaises(m.MemoryError):
            self.mem.database_context('collapse',recipient_profile='pro_macro',required=[code_clutter['id']])

        curated=m.dispatch('context',self.root,{'query':'collapse','recipient_profile':'focused_curated'})
        self.assertEqual(32000,curated['manifest']['max_chars'])

        panoramic=m.dispatch('context',self.root,{'query':'collapse','recipient_profile':'gemini_panoramic'})
        self.assertEqual(240000,panoramic['manifest']['max_chars'])
        self.assertIn(extra_paper['id'],panoramic['manifest']['selected_ids'])
        self.assertIn('Complete primary ergodic control paper',panoramic['text'])
        self.assertIn('=== JIT Recency Check ===',panoramic['text'])
        self.assertIn('Five-Tuple Isomorphism',panoramic['text'])

    def test_role_stance_kv_cache_prefix_and_jit_recency_card(self):
        src=self.save(kind='source',title='Primary Source',body='Shared primary specification alpha beta.')
        prop=self.save(kind='proposal',title='Candidate Proposal',body='Proposed unified operator alpha beta.',depends_on=[src['id']])
        pkt1=self.mem.database_context(
            'alpha',profile='review',allow=[src['id'],prop['id']],target=prop['id'],required=[src['id']],
            recipient_profile='focused_curated',role='reviewer',stance='deductive_auditor',
        )
        pkt2=self.mem.database_context(
            'beta',profile='review',allow=[src['id'],prop['id']],target=prop['id'],required=[src['id']],
            recipient_profile='focused_curated',role='reviewer',stance='deductive_auditor',
        )
        prefix_len=pkt1['manifest']['anchor_prefix_chars']
        self.assertEqual(prefix_len,pkt2['manifest']['anchor_prefix_chars'])
        self.assertEqual(pkt1['text'][:prefix_len],pkt2['text'][:prefix_len])
        self.assertIn('=== Role & Stance Contract ===',pkt1['text'][:prefix_len])
        self.assertIn('Role (reviewer):',pkt1['text'][:prefix_len])
        self.assertIn('Stance (deductive_auditor):',pkt1['text'][:prefix_len])
        self.assertEqual('reviewer',pkt1['manifest']['role'])
        self.assertEqual('deductive_auditor',pkt1['manifest']['stance'])
        self.assertTrue(pkt1['text'].rstrip().endswith('require endogenous operator repair.'))
        self.assertIn('=== JIT Recency Check ===',pkt1['text'])
        self.assertIn('<5% truncation OFF',pkt1['text'])

    def test_cli_context_role_stance_and_jit_before_timestamp(self):
        rec_file=self.root/'source.md'
        rec_file.write_text('Primary source body for alpha check.\n')
        prop_file=self.root/'proposal.md'
        prop_file.write_text('Candidate proposal for alpha check.\n')
        r1=self.root/'r1.json'
        r1.write_text(json.dumps({'kind':'source','title':'Src','summary':'s','source':'source.md','scope':'all'}))
        r2=self.root/'r2.json'
        r2.write_text(json.dumps({'kind':'proposal','title':'Prop','summary':'p','source':'proposal.md','scope':'all','depends_on':[1]}))
        self.assertEqual(0,m.main(['--project',str(self.root),'remember','r1.json']))
        self.assertEqual(0,m.main(['--project',str(self.root),'remember','r2.json']))
        rc=m.main([
            '--project',str(self.root),'context','alpha','--profile','review',
            '--allow','1,2','--target','2','--require','1','--max-chars','12000',
            '--role','reviewer','--stance','deductive_auditor','--output','review-pkt.md',
        ])
        self.assertEqual(0,rc)
        pkt_text=(self.root/'review-pkt.md').read_text()
        self.assertIn('=== Role & Stance Contract ===',pkt_text)
        self.assertIn('=== JIT Recency Check ===',pkt_text)
        self.assertLess(pkt_text.index('=== JIT Recency Check ==='),pkt_text.index('Assembled at '))

    def test_tombstone_word_cap_and_strict_hygiene(self):
        src = self.save(kind='source', title='S1', body='Measured baseline metric.')
        long_reason = ' '.join(['word'] * 41)
        with self.assertRaises(m.MemoryError):
            self.save(kind='source', title='S2', body='Updated baseline.', supersedes=src['id'], reason=long_reason)
        with self.assertRaises(m.MemoryError):
            self.mem.save(
                dict(kind='decision', title='D1', summary='Pick method', scope='all', body='Use operator X.', author='lead'),
                strict_hygiene=True,
            )
        ok_dec = self.mem.save(
            dict(kind='decision', title='D2', summary='Pick method', scope='all', body='Use operator X.', author='lead', depends_on=[src['id']]),
            strict_hygiene=True,
        )
        self.assertEqual('current', ok_dec['state'])

    def test_resume_context_injects_collaboration_recovery_readonly_and_skips_pro_macro(self):
        bridge_dir = self.root / '.agent-bridge'
        bridge_dir.mkdir(exist_ok=True)
        (bridge_dir / 'collaborators.json').write_text(json.dumps({
            'collaborationPolicyVersion': '2000-01-01-fixture-collab-v1',
            'protocolEpoch': 'fixture-protocol-v3',
            'channelPreferences': {'gemini': ['pi_pinned', 'antigravity_pinned']},
            'subagentLifecyclePolicy': {
                'retireAfterTaskHandback': {
                    '/root/fixture_worker': {
                        'boundTaskId': 'fixture-deployment-task',
                        'recordedModel': 'gpt-6-sol',
                        'recordedEffort': 'medium',
                    }
                }
            },
        }), encoding='utf-8')
        bconn = sqlite3.connect(bridge_dir / 'bridge.sqlite')
        bconn.execute("CREATE TABLE tasks(id TEXT, assigned_to TEXT, status TEXT, phase TEXT, required_model TEXT, metadata_json TEXT)")
        bconn.execute(
            "INSERT INTO tasks VALUES (?,?,?,?,?,?)",
            ('fixture-deployment-task', 'codex', 'in_progress', 'in_progress', 'gpt-6-sol', json.dumps({'effort': 'medium'})),
        )
        bconn.commit()
        bconn.close()

        self.save(kind='question', title='Resume Target', body='Check collaboration recovery injection alpha.')
        resumed = m.dispatch('context', self.root, {'query': 'alpha', 'profile': 'resume'})
        self.assertIn('=== Collaboration Recovery ===', resumed['text'])
        self.assertIn('2000-01-01-fixture-collab-v1', resumed['text'])
        self.assertIn('fixture-protocol-v3', resumed['text'])
        self.assertIn('fixture-deployment-task', resumed['text'])
        self.assertFalse((bridge_dir / 'bridge.sqlite-wal').exists())

        pro_pkt = m.dispatch('context', self.root, {'query': 'alpha', 'profile': 'resume', 'recipient_profile': 'pro_macro'})
        self.assertNotIn('=== Collaboration Recovery ===', pro_pkt['text'])

if __name__=='__main__':unittest.main()
