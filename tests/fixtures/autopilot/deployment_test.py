import importlib.util, pathlib, tempfile, os, unittest, subprocess, sys, json, hashlib
sys.dont_write_bytecode=True
ROOT=pathlib.Path(__file__).resolve().parents[3]
spec=importlib.util.spec_from_file_location('guard',ROOT/'tools/autopilot/deployment_guard.py')
g=importlib.util.module_from_spec(spec);spec.loader.exec_module(g)
class GuardTests(unittest.TestCase):
 def test_production_entry_rejects_python_path_injection_mode(self):
  with self.assertRaisesRegex(Exception,'ISOLATED_START_REQUIRED'):
   with g.open_deployment():pass
 def test_default_has_no_approval(self):
  with self.assertRaises(Exception):g.load_approval()
 def test_live_v1_is_never_adopted_even_if_no_new_lock_is_held(self):
  with tempfile.TemporaryDirectory() as d:
   code="import sqlite3,sys; c=sqlite3.connect(sys.argv[1]);c.execute('PRAGMA user_version=1');print('ready',flush=True);sys.stdin.read()"
   p=subprocess.Popen([sys.executable,'-u','-c',code,d+'/ledger.sqlite'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,text=True)
   try:
    self.assertEqual(p.stdout.readline().strip(),'ready')
    with self.assertRaisesRegex(Exception,'UNMANAGED|LIVE_STATE'):g.assert_store_quiescent(d)
   finally:p.stdin.close();p.wait(timeout=5);p.stdout.close()
 def test_closed_unmanaged_v1_still_requires_an_offline_migration(self):
  import sqlite3
  with tempfile.TemporaryDirectory() as d:
   c=sqlite3.connect(d+'/ledger.sqlite');c.execute('PRAGMA user_version=1');c.close()
   with self.assertRaisesRegex(Exception,'UNMANAGED'):g.assert_store_quiescent(d)
 def test_enrollment_cannot_authorize_v1_or_leftover_wal(self):
  import sqlite3
  with tempfile.TemporaryDirectory() as d:
   c=sqlite3.connect(d+'/ledger.sqlite');c.execute('PRAGMA user_version=1');c.close()
   pathlib.Path(d+'/enrollment.json').write_text('{}')
   with self.assertRaisesRegex(Exception,'OFFLINE_MIGRATION_REQUIRED'):g.assert_store_quiescent(d)
   c=sqlite3.connect(d+'/ledger.sqlite');c.execute('PRAGMA user_version=2');c.close()
   pathlib.Path(d+'/ledger.sqlite-wal').write_text('synthetic')
   with self.assertRaisesRegex(Exception,'SIDECARS_NOT_QUIESCENT'):g.assert_store_quiescent(d)
 def test_active_or_any_remote_intent_blocks_cold_restart(self):
  import sqlite3
  with tempfile.TemporaryDirectory() as d:
   pathlib.Path(d+'/enrollment.json').write_text('{}')
   c=sqlite3.connect(d+'/ledger.sqlite');c.executescript("PRAGMA user_version=2;CREATE TABLE singleton_lock(id INTEGER,task_id TEXT);INSERT INTO singleton_lock VALUES(1,'active');CREATE TABLE intents(kind TEXT,status TEXT);");c.close()
   with self.assertRaisesRegex(Exception,'JOBS_UNRESOLVED'):g.assert_store_quiescent(d)
   c=sqlite3.connect(d+'/ledger.sqlite');c.executescript("UPDATE singleton_lock SET task_id=NULL;INSERT INTO intents VALUES('validation','complete');");c.close()
   with self.assertRaisesRegex(Exception,'JOBS_UNRESOLVED'):g.assert_store_quiescent(d)
 def test_kernel_lock_rejects_another_real_process(self):
  with tempfile.TemporaryDirectory() as d:
   with g.exclusive_state(d):
    code="import importlib.util,sys;s=importlib.util.spec_from_file_location('g',sys.argv[1]);g=importlib.util.module_from_spec(s);s.loader.exec_module(g);\nwith g.exclusive_state(sys.argv[2]): print('BAD')"
    p=subprocess.run([sys.executable,'-B','-c',code,str(ROOT/'tools/autopilot/deployment_guard.py'),d],capture_output=True,text=True,timeout=5)
    self.assertNotEqual(p.returncode,0);self.assertIn('DEPLOYMENT_BUSY',p.stderr)
   with g.exclusive_state(d):pass
 def test_child_inherited_lock_survives_controller_exit(self):
  import signal, time
  with tempfile.TemporaryDirectory() as d:
   code="import importlib.util,sys,subprocess,os;s=importlib.util.spec_from_file_location('g',sys.argv[1]);g=importlib.util.module_from_spec(s);s.loader.exec_module(g);\nwith g.exclusive_state(sys.argv[2]) as handles:\n p=subprocess.Popen([sys.executable,'-c','import time;time.sleep(8)'],pass_fds=(handles[1],),stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL);print(p.pid,flush=True);os._exit(0)"
   p=subprocess.Popen([sys.executable,'-B','-u','-c',code,str(ROOT/'tools/autopilot/deployment_guard.py'),d],stdout=subprocess.PIPE,text=True)
   pid=int(p.stdout.readline());p.wait(timeout=5);p.stdout.close()
   try:
    with self.assertRaisesRegex(Exception,'DEPLOYMENT_BUSY'):
     with g.exclusive_state(d):pass
   finally:os.kill(pid,signal.SIGTERM)
   until=time.monotonic()+3
   while True:
    try:
     with g.exclusive_state(d):break
    except RuntimeError:
     if time.monotonic()>until:raise
     time.sleep(.02)
 def test_pinned_parent_survives_rename_without_following_replacement(self):
  with tempfile.TemporaryDirectory() as d:
   os.mkdir(d+'/old',0o700);os.mkdir(d+'/foreign',0o700)
   with g.exclusive_state(d+'/old') as (directory,lock):
    inode=os.fstat(directory).st_ino;os.rename(d+'/old',d+'/held');os.symlink(d+'/foreign',d+'/old')
    self.assertEqual(os.fstat(directory).st_ino,inode);self.assertIn('deployment.lock',os.listdir(directory))
    with self.assertRaises(Exception):
     with g.exclusive_state(d+'/old'):pass
 def test_symlink_parent_and_sidecar_are_rejected(self):
  with tempfile.TemporaryDirectory() as d:
   os.mkdir(d+'/real',0o700);os.symlink(d+'/real',d+'/alias')
   with self.assertRaises(Exception):
    with g.exclusive_state(d+'/alias'):pass
   os.symlink(d+'/foreign',d+'/real/ledger.sqlite-wal')
   with self.assertRaisesRegex(Exception,'STATE_ENTRY'):
    with g.exclusive_state(d+'/real'):pass
 def test_stopped_contract_rejects_live_unloaded_unmasked_or_unknown_jobs(self):
  controller=dict(LoadState='masked',UnitFileState='masked',ActiveState='inactive',SubState='dead',MainPID='0',ControlGroup='',TasksCurrent='0')
  jobs=dict(LoadState='masked',UnitFileState='masked',ActiveState='inactive',SubState='dead',ControlGroup='',TasksCurrent='0')
  g.assert_stopped(controller,jobs)
  for field,value in [('LoadState','not-found'),('UnitFileState','disabled'),('ActiveState','active'),('MainPID','12'),('ControlGroup','/live'),('TasksCurrent','1')]:
   with self.assertRaises(Exception):g.assert_stopped(dict(controller,**{field:value}),jobs)
  with self.assertRaises(Exception):g.assert_stopped(controller,dict(jobs,ActiveState='active'))
 def test_exact_bytes_and_missing_or_extra_approval_entries(self):
  with tempfile.TemporaryDirectory() as d:
   p=pathlib.Path(d);(p/'entry.mjs').write_text('export const x=1;');os.chmod(p/'entry.mjs',0o400)
   files={'entry.mjs':hashlib.sha256((p/'entry.mjs').read_bytes()).hexdigest()}
   g.verify_bytes(d,files,expected_owner=os.getuid())
   os.chmod(p/'entry.mjs',0o600);(p/'entry.mjs').write_text('export const x=2;');os.chmod(p/'entry.mjs',0o400)
   with self.assertRaisesRegex(Exception,'BYTE_MISMATCH'):g.verify_bytes(d,files,expected_owner=os.getuid())
   with self.assertRaises(Exception):g.verify_bytes(d,{'../outside':'a'*64},expected_owner=os.getuid())
 def test_private_state_file_modes_and_daemon_names_reject(self):
  with tempfile.TemporaryDirectory() as d:
   os.chmod(d,0o755)
   with self.assertRaises(Exception):
    with g.exclusive_state(d):pass
   os.chmod(d,0o700);pathlib.Path(d+'/daemon.sqlite').write_text('synthetic daemon fixture')
   with self.assertRaisesRegex(Exception,'STATE_ENTRY_NAME'):
    with g.exclusive_state(d):pass
if __name__=='__main__':unittest.main(verbosity=2)
