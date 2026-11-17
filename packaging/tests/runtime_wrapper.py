"""Source runtime launcher for isolated fixtures only."""
import importlib.util
import os
from pathlib import Path
import sys

root=Path(os.environ['SBM_TEST_ROOT'])
profile=Path(os.environ['LOCALAPPDATA']).resolve()
sys.path.insert(0,str(root))
def guard(event,args):
    if event=='open' and isinstance(args[0],(str,bytes,os.PathLike)):
        p=Path(os.fsdecode(args[0])).resolve()
        secret=p.name.startswith('.env') or p.name=='config.json' or p.suffix in ('.db','.sqlite','.session')
        if secret and not p.is_relative_to(profile):raise PermissionError('non-fixture state access')
sys.addaudithook(guard)
spec=importlib.util.spec_from_file_location('entry',root/'packaging/standalone_entry.py')
entry=importlib.util.module_from_spec(spec);spec.loader.exec_module(entry)
def browser(origin):
    # Duplicate launch only reopens a browser; it intentionally never imports
    # the application/configuration. Probe the primary server process only.
    if 'config' in sys.modules:
        config = sys.modules['config']
        assert not hasattr(config, "LLM_API_KEY") and not hasattr(config, "LITELLM_PROXY_KEY")
        assert all(key not in os.environ for key in ("TELEGRAM_API_ID", "TELEGRAM_API_HASH", "LLM_API_KEY", "LITELLM_PROXY_KEY", "OPENAI_API_KEY"))
        (profile/'provider-boundary.txt').write_text('PASS: inherited synthetic keys absent; safe defaults only')
    with open(profile/'opened.txt','a') as f:f.write(origin+'\n')
entry._open_browser=browser
# The app then takes whoever connects for a program of another Windows user: a second account can't be made in a test.
if os.environ.get('SBM_TEST_ANOTHER_USER'):
    import local_peer
    local_peer.own_user=lambda:b'another user'
# The port this copy wanted is held by another person's program: nobody else is signed in during a test.
if os.environ.get('SBM_TEST_SOMEONE_ELSE'):
    import local_peer
    local_peer.someone_else_listens=lambda port:True
entry._notify=lambda message: (profile/'startup-error.txt').write_text(message)
raise SystemExit(entry.main())
