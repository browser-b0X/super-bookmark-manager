"""Synthetic client only. Never imports or contacts Telethon."""
from datetime import datetime, timezone
from types import SimpleNamespace, ModuleType
import importlib.abc
import sys

MODE = 'normal'
CALLS = []
MessageEntityTextUrl = type('MessageEntityTextUrl', (), {})


def messages():
    def msg(identifier, text, entities=None):
        return SimpleNamespace(id=identifier, message=text, date=datetime(2026, 9, 24, tzinfo=timezone.utc), entities=entities or [])
    link = MessageEntityTextUrl()
    link.url = 'https://live.example.invalid/art'
    items = [
        msg(501, 'https://journeys.example.invalid/travel'),
        msg(502, 'https://live.example.invalid/cooking'),
        msg(503, 'https://live.example.invalid/programming https://live.example.invalid/exercise'),
        msg(504, 'Labeled art reference', [link]),
        msg(505, 'No links in this message'),
        msg(506, 'ftp://unsupported.invalid/file'),
        msg(507, 'https://live.example.invalid/cooking'),
        msg(508, 'https://example.invalid/reference'),
        None,
    ]
    items.extend(msg(600 + i, 'No link') for i in range(191))
    items.append(msg(900, 'https://live.example.invalid/outside-window'))
    if MODE == 'extra': items[0] = msg(901, 'https://live.example.invalid/provider-failure')
    if MODE == 'malformed': return [None]
    if MODE == 'empty': return []
    return items


class FakeClient:
    def __init__(self, *args, **kwargs): CALLS.append({'action': 'construct'})
    async def connect(self): CALLS.append({'action': 'connect'})
    async def is_user_authorized(self): return MODE != 'unauthorized'
    async def get_messages(self, target, limit):
        CALLS.append({'action': 'get_messages', 'target': target, 'limit': limit})
        if MODE == 'network': raise OSError('PRIVATE EXCEPTION MUST NOT LEAK')
        if MODE == 'unexpected': return None
        return messages()  # Deliberately overreturns; the production boundary must cap it too.
    async def disconnect(self): CALLS.append({'action': 'disconnect'})
    async def start(self): raise AssertionError('Interactive auth forbidden')


class Missing(importlib.abc.MetaPathFinder):
    def find_spec(self, fullname, path=None, target=None):
        if fullname.split('.')[0] == 'telethon':
            raise ModuleNotFoundError('Synthetic missing Telethon', name='telethon')


sys.meta_path.insert(0, Missing())


def set_mode(mode):
    global MODE
    MODE = mode
    sys.modules.pop('telethon', None)
    if mode != 'missing':
        module = ModuleType('telethon')
        module.TelegramClient = FakeClient
        sys.modules['telethon'] = module


set_mode('normal')
