"""Cold-only, externally approved Linux deployment audit; not an enabler.
No unmanaged DB adoption/rolling upgrade, automatic stop/start, or boolean verifier.
The context must span the future controller lifetime; it is not a transferable permit.
"""
import contextlib
import fcntl
import hashlib
import json
import os
import re
import stat
import subprocess
import sys
import sqlite3

APPROVAL = '/etc/ai-turn-meter/autopilot/approval.json'
CONTROLLER = 'ai-turn-meter-autopilot.service'
JOBS = 'ai-turn-meter-autopilot-jobs.slice'
CORE = ['contracts.mjs', 'policy.mjs', 'policy.json', 'state.mjs', 'sandbox.mjs', 'deployment_guard.py']
HOSTED = ['contract.mjs', 'host-probe.mjs', 'run-synthetic.mjs', 'harness.mjs']
FIXTURES = ['baseline.mjs', 'cpu.mjs', 'pids.mjs', 'memory.mjs', 'timeout.mjs']
CLOSURE = (['tools/autopilot/' + p for p in CORE]
           + ['tools/autopilot/hosted-preflight/' + p for p in HOSTED]
           + ['tools/autopilot/hosted-preflight/fixtures/' + p for p in FIXTURES])


def require(ok, reason):
    if not ok:
        raise RuntimeError(reason)


@contextlib.contextmanager
def pinned_directory(path, expected_owner=None, trusted_ancestors=False):
    require(os.path.isabs(path) and '..' not in path.split('/'), 'ABSOLUTE_PATH_REQUIRED')
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in path.split('/'):
            if not part:
                continue
            nxt = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = nxt
            info = os.fstat(fd)
            require(info.st_uid in ((0,) if trusted_ancestors else (0, os.getuid())), 'PARENT_OWNER')
            sticky_root = info.st_uid == 0 and bool(info.st_mode & stat.S_ISVTX)
            require(not info.st_mode & 0o022 or sticky_root, 'WRITABLE_PARENT')
        if expected_owner is not None:
            require(os.fstat(fd).st_uid == expected_owner, 'DIRECTORY_OWNER')
        yield fd
    finally:
        os.close(fd)


def regular_stat(directory, name, owner, private=False):
    require('/' not in name and name not in ('', '.', '..'), 'FILE_NAME')
    info = os.stat(name, dir_fd=directory, follow_symlinks=False)
    require(stat.S_ISREG(info.st_mode) and info.st_uid == owner and info.st_nlink == 1, 'FILE_IDENTITY')
    require(not info.st_mode & (0o077 if private else 0o022), 'FILE_MODE')
    return info


def read_regular(directory, name, owner, immutable=False):
    info = regular_stat(directory, name, owner)
    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=directory)
    try:
        actual = os.fstat(fd)
        require((actual.st_dev, actual.st_ino) == (info.st_dev, info.st_ino), 'FILE_REPLACED')
        require(actual.st_size <= 1048576 and (not immutable or not actual.st_mode & 0o222), 'FILE_MODE_OR_SIZE')
        data = os.read(fd, 1048577)
        require(len(data) <= 1048576, 'FILE_SIZE')
        return data
    finally:
        os.close(fd)


def load_approval():
    # Fixed root-controlled path, not chosen by an Issue, environment, or flag.
    with pinned_directory(os.path.dirname(APPROVAL), expected_owner=0, trusted_ancestors=True) as fd:
        result = json.loads(read_regular(fd, 'approval.json', 0))
    keys = {'schemaVersion', 'repoId', 'revision', 'installRoot', 'stateRoot', 'stateIdentity', 'files'}
    require(set(result) == keys and result['schemaVersion'] == 1 and result['repoId'] == '1461122513', 'APPROVAL_SCHEMA')
    require(isinstance(result['revision'], str) and re.fullmatch('[a-f0-9]{40}', result['revision']), 'APPROVAL_REVISION')
    require(isinstance(result['stateIdentity'], str) and re.fullmatch('[a-f0-9]{64}', result['stateIdentity']), 'APPROVAL_STATE_IDENTITY')
    require(isinstance(result['files'], dict) and set(CLOSURE).issubset(result['files']), 'APPROVAL_CLOSURE')
    return result


def verify_bytes(root, files, expected_owner=0):
    require(isinstance(files, dict) and 0 < len(files) <= 100, 'APPROVAL_FILES')
    for name, digest in files.items():
        require(isinstance(name, str) and not name.startswith('/') and all(p not in ('', '.', '..') for p in name.split('/')), 'APPROVAL_PATH')
        require(isinstance(digest, str) and re.fullmatch('[a-f0-9]{64}', digest), 'APPROVAL_DIGEST')
        parent, leaf = os.path.split(name)
        with pinned_directory(os.path.join(root, parent), expected_owner=expected_owner, trusted_ancestors=expected_owner == 0) as directory:
            content = read_regular(directory, leaf, expected_owner, immutable=True)
        require(hashlib.sha256(content).hexdigest() == digest, 'BYTE_MISMATCH')


def assert_stopped(controller, jobs):
    for item in (controller, jobs):
        require(item.get('LoadState') == 'masked' and item.get('UnitFileState') == 'masked', 'DEPLOYMENT_NOT_MASKED')
        require(item.get('ActiveState') == 'inactive' and item.get('SubState') == 'dead', 'DEPLOYMENT_NOT_STOPPED')
        require(item.get('ControlGroup') == '' and item.get('TasksCurrent') in ('0', '[not set]'), 'JOBS_NOT_PROVEN_STOPPED')
    require(controller.get('MainPID') == '0', 'CONTROLLER_NOT_STOPPED')


def stopped_units():
    env = {'PATH': '/usr/bin:/bin', 'XDG_RUNTIME_DIR': f'/run/user/{os.getuid()}',
           'DBUS_SESSION_BUS_ADDRESS': f'unix:path=/run/user/{os.getuid()}/bus'}
    def show(unit):
        value = subprocess.check_output(['/usr/bin/systemctl', '--user', 'show', unit,
            '--property=LoadState,UnitFileState,ActiveState,SubState,MainPID,ControlGroup,TasksCurrent'],
            env=env, text=True, timeout=5, stderr=subprocess.PIPE)
        return dict(line.split('=', 1) for line in value.splitlines() if '=' in line)
    # Read actual manager state; no callback or user-controlled JSON is authority.
    assert_stopped(show(CONTROLLER), show(JOBS))


@contextlib.contextmanager
def exclusive_state(root):
    with pinned_directory(root, expected_owner=os.getuid()) as directory:
        require(stat.S_IMODE(os.fstat(directory).st_mode) == 0o700, 'STATE_DIRECTORY_MODE')
        fd = os.open('deployment.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600, dir_fd=directory)
        try:
            info = os.fstat(fd)
            require(stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid() and info.st_nlink == 1 and stat.S_IMODE(info.st_mode) == 0o600, 'STATE_LOCK_IDENTITY')
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as error:
                raise RuntimeError('DEPLOYMENT_BUSY') from error
            for name in os.listdir(directory):
                require(name in ('deployment.lock', 'enrollment.json', 'ledger.sqlite', 'ledger.sqlite-wal', 'ledger.sqlite-shm'), 'STATE_ENTRY_NAME')
                try:
                    regular_stat(directory, name, os.getuid(), private=True)
                except Exception as error:
                    raise RuntimeError('STATE_ENTRY_IDENTITY') from error
            yield directory, fd
        finally:
            os.close(fd)


def assert_store_fd_quiescent(directory):
    entries = os.listdir(directory)
    require('ledger.sqlite' not in entries or 'enrollment.json' in entries, 'UNMANAGED_LEGACY_STATE')
    require(not any(x in entries for x in ('ledger.sqlite-wal', 'ledger.sqlite-shm')), 'SIDECARS_NOT_QUIESCENT')
    if 'ledger.sqlite' in entries:
        # No sidecar replay or writes here. Parent is an already pinned descriptor.
        # Existing v1 cannot become safe merely by adding an enrollment JSON.
        db = sqlite3.connect(f'file:/proc/self/fd/{directory}/ledger.sqlite?mode=ro&immutable=1', uri=True)
        try:
            require(db.execute('PRAGMA user_version').fetchone()[0] == 2, 'OFFLINE_MIGRATION_REQUIRED')
            require(db.execute('SELECT task_id FROM singleton_lock WHERE id=1').fetchone() == (None,), 'JOBS_UNRESOLVED')
            # Complete intent means creation was acknowledged, not that a remote
            # job stopped. Until a real remote stop adapter exists, reject all.
            require(db.execute('SELECT COUNT(*) FROM intents').fetchone()[0] == 0, 'JOBS_UNRESOLVED')
        finally:
            db.close()


def assert_store_quiescent(root):
    with pinned_directory(root, expected_owner=os.getuid()) as directory:
        assert_store_fd_quiescent(directory)


@contextlib.contextmanager
def open_deployment():
    require(sys.flags.isolated == 1, 'ISOLATED_START_REQUIRED')
    require(os.name == 'posix' and os.path.exists('/proc/self/fd') and os.getuid() != 0, 'LINUX_UNPRIVILEGED_REQUIRED')
    approval = load_approval()
    require(os.path.realpath(__file__) == os.path.join(approval['installRoot'], 'tools/autopilot/deployment_guard.py'), 'BOOTSTRAP_NOT_INSTALLED')
    verify_bytes(approval['installRoot'], approval['files'])
    with exclusive_state(approval['stateRoot']) as handles:
        stopped_units()
        directory, lock = handles
        assert_store_fd_quiescent(directory)
        if 'enrollment.json' in os.listdir(directory):
            marker = json.loads(read_regular(directory, 'enrollment.json', os.getuid()))
            require(marker == {'stateIdentity': approval['stateIdentity'], 'controller': CONTROLLER, 'jobs': JOBS}, 'ENROLLMENT_MISMATCH')
        # No enrollment, migration, backup, unmask/start or candidate execution here.
        # The future supervisor must retain both descriptors throughout its lifetime.
        yield {'approval': approval, 'directory_fd': directory, 'lock_fd': lock}


if __name__ == '__main__':
    with open_deployment():
        print('COLD_AUDIT_ONLY: no enrollment, migration or controller startup')
