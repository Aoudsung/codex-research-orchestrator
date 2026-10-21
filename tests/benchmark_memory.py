import contextlib
import importlib.util
import io
import json
import statistics
import tempfile
import time
from pathlib import Path

script = Path('skills/codex-research-orchestrator/scripts/research_memory.py').resolve()
spec = importlib.util.spec_from_file_location('research_memory', script)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
with tempfile.TemporaryDirectory(prefix='memory-scale-') as directory:
    project = Path(directory)
    (project / 'controls.md').write_text('Study matching and vertex cover. Theory only. No external sharing.\n')
    memory = module.Memory(project, ['controls.md'])
    total = 0
    for index in range(1000):
        term = 'matching vertex cover' if index < 12 else 'unrelated experimental archive'
        body = (term + ' finite simple graph conditions and source details.\n') * 12
        name = 'source-' + str(index) + '.md'
        (project / name).write_text(body)
        total += len(body)
        memory.remember({'kind': 'evidence', 'title': 'Source ' + str(index), 'summary': term, 'source': name, 'scope': 'Synthetic retrieval check only.'})
    timings = []
    for _ in range(3):
        start = time.perf_counter()
        results = memory.search('matching', limit=5)
        timings.append(time.perf_counter() - start)
    start = time.perf_counter()
    packet = memory.context('matching', 'resume', 12000, 'packet.md')
    packet_time = time.perf_counter() - start
    memory.close()
    output = io.StringIO()
    with contextlib.redirect_stdout(output):
        code = module.main(['--project', str(project), 'context', 'matching', '--max-chars', '12000', '--output', 'cli-packet.md'])
    assert code == 0
    assert packet['packet_chars'] <= 12000
    assert len(results['results']) == 5
    print(json.dumps({'records': 1000, 'source_chars': total, 'search_result_count': len(results['results']), 'search_median_ms': round(statistics.median(timings)*1000, 2), 'context_ms': round(packet_time*1000,2), 'packet_chars':packet['packet_chars'], 'budget_chars':12000, 'context_cli_stdout_chars':len(output.getvalue())}))
