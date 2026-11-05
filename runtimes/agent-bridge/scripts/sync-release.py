#!/usr/bin/env python3
"""Generate one release manifest and install identical managed files atomically."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import tempfile
from datetime import datetime, timezone

ROOT = Path(__file__).resolve().parents[1]
ROOT_FILES = {'package.json', 'README.md', 'LICENSE', 'release-manifest.json'}
TREES = {'src', 'scripts', 'docs', 'test'}


def managed(root):
    return sorted(p for p in root.rglob('*') if p.is_file() and not p.is_symlink()
                  and (p.relative_to(root).parts[0] in TREES or p.relative_to(root).as_posix() in ROOT_FILES)
                  and not any(x in {'__pycache__', 'node_modules', '.DS_Store'} for x in p.relative_to(root).parts))


def build_manifest():
    hashes = {p.relative_to(ROOT).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest()
              for p in managed(ROOT) if p.name != 'release-manifest.json'}
    digest = hashlib.sha256(json.dumps(hashes, sort_keys=True).encode()).hexdigest()
    version = json.loads((ROOT / 'package.json').read_text())['version']
    previous = ROOT / 'release-manifest.json'
    if previous.exists():
        old = json.loads(previous.read_text())
        if old.get('files') == hashes:
            return old
    manifest = {'releaseId': f'bridge-{version}-{digest[:12]}', 'version': version,
                'protocolVersion': 2, 'supportedProtocols': [1, 2], 'schemaVersion': 3,
                'createdAt': datetime.now(timezone.utc).isoformat(), 'files': hashes}
    temporary = previous.with_suffix('.json.tmp')
    temporary.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
    os.replace(temporary, previous)
    return manifest


def install(destination, manifest, backup_root=None):
    destination = destination.expanduser().absolute()
    if destination == ROOT or ROOT.is_relative_to(destination):
        raise ValueError('Destination cannot contain the source runtime')
    if destination.is_symlink():
        raise ValueError('Destination must be a real directory')
    for parent in destination.parents:
        if parent.is_symlink():
            raise ValueError('Destination parents must be real directories')
    destination.parent.mkdir(parents=True, exist_ok=True)
    stage = Path(tempfile.mkdtemp(prefix=f'.{destination.name}-install-', dir=destination.parent))
    if backup_root:
        backup_root.mkdir(parents=True, exist_ok=True)
        suffix = hashlib.sha256(str(destination).encode()).hexdigest()[:8]
        backup = backup_root / f'{destination.name}-{suffix}-{manifest["releaseId"]}'
    else:
        backup = destination.with_name(f'.{destination.name}-backup-{manifest["releaseId"]}')
    switched = False
    try:
        if destination.exists():
            shutil.copytree(destination, stage, dirs_exist_ok=True, symlinks=True,
                            ignore=shutil.ignore_patterns('.backups', '__pycache__', 'node_modules'))
        for source in managed(ROOT):
            target = stage / source.relative_to(ROOT)
            if target.is_symlink() or any(p.is_symlink() for p in target.parents if p != stage.parent):
                raise ValueError('Managed destination contains a symlink')
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, target)
        if destination.exists():
            # Keep all previous installs; the release can be retried without overwriting a backup.
            if backup.exists():
                backup = backup.with_name(backup.name + '-' + datetime.now(timezone.utc).strftime('%Y%m%d%H%M%S%f'))
            os.replace(destination, backup)
            switched = True
        try:
            os.replace(stage, destination)
        except BaseException:
            if switched:
                os.replace(backup, destination)
            raise
        return {'destination': str(destination), 'releaseId': manifest['releaseId'],
                'backup': str(backup) if switched else None}
    finally:
        if stage.exists():
            shutil.rmtree(stage)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--mirror', type=Path, action='append', default=[])
    parser.add_argument('--global-install', type=Path)
    args = parser.parse_args()
    manifest = build_manifest()
    results = [install(p, manifest, ROOT.parent / '.release-backups') for p in args.mirror]
    if args.global_install:
        results.append(install(args.global_install, manifest))
    print(json.dumps({'releaseId': manifest['releaseId'], 'installed': results}, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
