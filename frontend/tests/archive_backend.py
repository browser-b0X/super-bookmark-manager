"""Save a copy: synthetic pages on an owned loopback server only.

Run: python -B frontend/tests/archive_backend.py
Uses the metadata fixture's guarded HTTP server (public-looking fixture hosts
mapped to loopback) and a temporary folder under .verify. No personal data,
no real network.
"""
import base64
from html.parser import HTMLParser
import json
import os
from pathlib import Path
import re
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

WORKSPACE = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(WORKSPACE))
sys.dont_write_bytecode = True
from metadata_fixture import BASE_URL, JPEG, ControlledHTTP, install_guard, GUARD_FAILURES

(WORKSPACE / ".verify" / "archive").mkdir(parents=True, exist_ok=True)
FIXTURE = tempfile.TemporaryDirectory(prefix="archive-fixture-", dir=WORKSPACE / ".verify" / "archive")
ROOT = Path(FIXTURE.name)
install_guard(ROOT)
os.environ["SAVED_POSTS_DB_PATH"] = str(ROOT / "synthetic.sqlite")
os.environ["SBM_ARCHIVE_DIR"] = str(ROOT / "default-archive")
import archive
import safe_http
import storage
try:
    import app as dashboard
except ModuleNotFoundError:      # Flask missing: the route tests are skipped, the rest still run
    dashboard = None

CDN = "http://cdn.fixture.test"
PNG = b"\x89PNG\r\n\x1a\n" + b"synthetic-png" * 40
GIF = b"GIF89a" + b"synthetic-gif" * 40
WEBP = b"RIFF\x00\x00\x00\x00WEBP" + b"synthetic-webp" * 40
SVG = b'<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><rect width="4" height="4"/></svg>'
TINY_GIF = "data:image/gif;base64," + base64.b64encode(b"GIF89a" + b"\x01" * 30).decode()


def b64(data):
    return base64.b64encode(data).decode("ascii")


def body_of(document):
    """The page's own content, after the app's banner."""
    return document.split("</div></div>", 1)[1] if "data-sbm-saved-copy" in document else document


class ArchiveCase(unittest.TestCase):
    def setUp(self):
        self.http = ControlledHTTP().__enter__()
        self.addCleanup(self.http.__exit__, None, None, None)
        self.store = ROOT / self._testMethodName
        self.store.mkdir()
        for name, value in (("ARCHIVE_DIR", str(self.store)), ("HOST_SPACING", 0.0)):
            patcher = patch.object(archive, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        with archive._lock:
            archive._jobs.clear()
            archive._host_last.clear()
        self.guard_count = len(GUARD_FAILURES)

    def tearDown(self):
        self.assertTrue(archive.wait_idle(20), "archive queue did not finish")
        self.assertEqual(GUARD_FAILURES[self.guard_count:], [], "Production crossed the synthetic isolation boundary")

    def image(self, path, data, kind):
        self.http.routes[path] = (200, {"Content-Type": kind}, data)

    def copy(self, path="/page", base=BASE_URL):
        document, record = archive.build_copy(base + path)
        return document.decode("utf-8"), record

    def paths(self):
        return [request[0] for request in self.http.requests]

    def assert_inert(self, document):
        """Parse the copy the way a browser would and check nothing in it can act."""
        audit = _Audit()
        audit.feed(document)
        audit.close()
        forbidden = {"script", "iframe", "frame", "frameset", "object", "embed", "applet", "form", "input", "button", "svg",
                     "math", "base", "link", "textarea", "select", "video", "audio", "source", "template", "canvas"}
        self.assertEqual(audit.tags & forbidden, set())
        self.assertEqual([name for name in audit.attributes if name.startswith("on")], [], "event-handler attribute survived")
        self.assertEqual(audit.attributes & {"srcset", "action", "formaction", "background", "ping", "srcdoc", "data"}, set())
        # The only <meta http-equiv> is the copy's own policy; a page cannot add a refresh.
        self.assertEqual(audit.http_equiv, ["content-security-policy"])
        for kind, value in audit.urls:
            if kind == "src":
                self.assertTrue(value.startswith("data:image/"), value[:60])
            else:
                self.assertTrue(value.startswith(("http://", "https://", "#")), value[:60])
        self.assertNotIn("javascript:", document.lower())


class _Audit(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.tags, self.attributes, self.urls, self.http_equiv = set(), set(), [], []

    def handle_starttag(self, tag, attrs):
        self.tags.add(tag)
        for name, value in attrs:
            self.attributes.add(name)
            if name in ("src", "href"):
                self.urls.append((name, value or ""))
            if tag == "meta" and name == "http-equiv":
                self.http_equiv.append((value or "").lower())


class CleaningTests(ArchiveCase):
    def test_scripts_handlers_frames_and_forms_are_removed(self):
        self.http.html("/page", """<!doctype html><html lang="en" onclick="pwn()"><head><title>Hostile &amp; page</title>
            <script>window.pwned = 1</script><meta http-equiv="refresh" content="0;url=https://evil.invalid/"><base target="_top">
            </head><body onload="pwn()" class="main"><h1 onclick="pwn()" id="top">Heading</h1>
            <p>Para <a href="javascript:pwn()">bad link</a> <a href="/next?a=1&b=2" onmouseover="pwn()">good link</a>
            <a href="#top">jump</a> <a href="data:text/html,<script>pwn()</script>">data link</a></p>
            <iframe src="https://evil.invalid/frame"><p>iframe inner</p></iframe>
            <object data="x.swf"><p>object inner</p></object><embed src="x.swf">
            <form action="/steal"><input name="q" value="secret-input"><button>Send it</button><p>inside form text</p>
            <select><option>option text</option></select><textarea>typed text</textarea></form>
            <svg onload="pwn()"><script>pwn()</script><text>svg text</text></svg>
            <img src="x" onerror="pwn()">
            <table><tr><td colspan="2">cell</td></tr></table><ul><li>item</li></ul>
            <script>document.write("written")</script><ScRiPt SRC="https://evil.invalid/x.js"></ScRiPt>
            <noscript><p>noscript text</p></noscript><custom-card data-x="1">custom text</custom-card>
            <!-- comment <script>pwn()</script> --><video src="v.mp4">video text</video>
            </body></html>""")
        document, record = self.copy()
        self.assert_inert(document)
        page = body_of(document)
        for gone in ("pwn(", "window.pwned", "evil.invalid", "secret-input", "iframe inner", "object inner", "svg text",
                     "written", "option text", "typed text", "Send it", "video text", "comment", "data:text"):
            self.assertNotIn(gone, document)
        for kept in ("Heading", "Para", "bad link", "good link", "cell", "item", "inside form text", "noscript text", "custom text"):
            self.assertIn(kept, page)
        self.assertIn('<a href="http://metadata.fixture.test/next?a=1&amp;b=2" target="_blank" rel="noopener noreferrer nofollow">good link</a>', page)
        self.assertIn('<a href="#top">jump</a>', page)
        self.assertIn("<a>bad link</a>", page)
        self.assertIn("<a>data link</a>", page)
        self.assertIn('<td colspan="2">cell</td>', page)
        self.assertIn('<html lang="en">', document)
        self.assertIn('<body class="main">', document)
        self.assertIn("<title>Hostile &amp; page</title>", document)
        self.assertEqual(record["title"], "Hostile & page")
        self.assertTrue(document.startswith("<!DOCTYPE html>"))
        self.assertIn(f'<meta http-equiv="Content-Security-Policy" content="{archive.FILE_CSP}">', document)
        self.assertLess(document.index("Content-Security-Policy"), document.index("<title>"))
        self.assertEqual(record["bytes"], len(document.encode("utf-8")))

    def test_text_and_attributes_cannot_become_markup(self):
        self.http.html("/page", """<title>&lt;/title&gt;&lt;script&gt;pwn()&lt;/script&gt;</title>
            <p title='"><script>pwn()</script>' class="a&quot; onclick=&quot;pwn()">&lt;script&gt;alert(1)&lt;/script&gt; and <b>bold</b></p>
            <a href='http://metadata.fixture.test/"onclick="pwn()'>quoted link</a>
            <img src="/a.jpg" alt='"><script>pwn()</script>' width='1" onerror="pwn()'>""")
        self.image("/a.jpg", JPEG, "image/jpeg")
        document, record = self.copy()
        self.assert_inert(document)
        self.assertIn("&lt;script&gt;alert(1)&lt;/script&gt; and <b>bold</b>", document)
        self.assertIn('title="&quot;&gt;&lt;script&gt;pwn()&lt;/script&gt;"', document)
        self.assertIn('class="a&quot; onclick=&quot;pwn()"', document)
        self.assertIn('href="http://metadata.fixture.test/&quot;onclick=&quot;pwn()"', document)
        self.assertIn('width="1&quot; onerror=&quot;pwn()"', document)
        self.assertEqual(record["title"], "</title><script>pwn()</script>")
        self.assertIn("<title>&lt;/title&gt;&lt;script&gt;pwn()&lt;/script&gt;</title>", document)

    def test_unclosed_and_malformed_markup_keeps_the_page(self):
        self.http.routes["/page"] = (200, {"Content-Type": "text/html; charset=windows-1252"},
                                     "<div><button>Menu<div><p>Body text \u201cquoted\u201d here</p></div><span>tail".encode("windows-1252")
                                     + b"<p>after<script>never closed")
        document, _ = self.copy()
        self.assert_inert(document)
        page = body_of(document)
        self.assertIn("Body text \u201cquoted\u201d here", page)
        self.assertIn("tail", page)
        self.assertIn("after", page)
        self.assertNotIn("never closed", page)
        self.assertNotIn("Menu", page)
        for tag in ("div", "p", "span"):
            self.assertEqual(page.count(f"<{tag}"), page.count(f"</{tag}>"), tag)

    def test_left_out_end_tags_keep_long_lists_and_tables_whole(self):
        # Valid HTML: </li>, </tr>, </td> and </p> are optional, and minified pages drop them.
        rows = "".join(f"<tr><td>r{n}a<td>r{n}b<td><a href=/row/{n}>item {n}</a>" for n in range(100))
        items = "".join(f"<li>entry {n}" for n in range(300))
        paragraphs = "".join(f"<p>para {n}" for n in range(300))
        self.http.html("/page", f"<title>Long</title><table>{rows}</table><ul>{items}</ul>{paragraphs}<div id=after>end</div>")
        document, _ = self.copy()
        page = body_of(document)
        self.assertEqual(page.count('<a href="http://metadata.fixture.test/row/'), 100, "every row keeps its link")
        self.assertIn("<td>r99a</td><td>r99b</td>", page)
        self.assertEqual(page.count("<li>"), 300)
        self.assertIn("<li>entry 299</li>", page)
        self.assertIn("<p>para 299</p>", page)
        self.assertIn('<div id="after">end</div>', page)
        for tag in ("tr", "td", "li", "p", "table", "ul"):
            self.assertEqual(page.count(f"<{tag}>") + page.count(f"<{tag} "), page.count(f"</{tag}>"), tag)

    def test_a_picture_used_twice_is_shown_twice(self):
        self.image("/star.png", PNG, "image/png")
        self.http.html("/page", '<title>Stars</title><p><img src="/star.png" alt="first star"> one</p>'
                                '<p><img src="/star.png" alt="second star"> two</p>'
                                '<p><img data-src="/star.png" alt="lazy"><noscript><img src="/star.png" alt="twin"></noscript></p>')
        document, _ = self.copy()
        page = body_of(document)
        self.assertIn('alt="first star"', page)
        self.assertIn('alt="second star"', page)
        self.assertIn('alt="lazy"', page)
        self.assertNotIn('alt="twin"', page, "a lazy picture's <noscript> twin is still one picture")

    def test_script_built_page_is_marked_limited(self):
        self.http.html("/page", '<title>App</title><div id="root"></div><noscript>You need to enable JavaScript to run this app.</noscript>')
        document, record = self.copy()
        self.assertTrue(record["limited"])
        self.assertIn("builds itself with scripts", document)
        self.http.html("/article", "<title>Article</title><article>" + "<p>" + "word " * 120 + "</p></article>")
        document, record = self.copy("/article")
        self.assertFalse(record["limited"])
        self.assertNotIn("builds itself with scripts", document)


class StylesheetTests(ArchiveCase):
    def test_stylesheets_are_inlined_and_cannot_load_or_break_out(self):
        self.http.html("/page", """<head><link rel="stylesheet" href="/site.css"><link rel="stylesheet" media="print" href="/print.css">
            <link rel="alternate stylesheet" href="/alt.css"><link rel="stylesheet" media="(min-width: 600px)" href="http://cdn.fixture.test/wide.css">
            <link rel="preload" as="style" href="/preload.css"><link rel="icon" href="/icon.png">
            <style>@import url("/more.css"); .a{background:url(/bg.png)} .b{background:url( 'http://cdn.fixture.test/t.gif' ) no-repeat}
            .c{background:url(data:image/png;base64,AAAA)}
            .e{width:expression(pwn())} /* url(/comment.png) */ .f{color:#0a0b0c}</style></head>
            <body><p style="color:red;background:url(http://cdn.fixture.test/attr.gif)" class="a">Styled</p></body>""")
        self.http.routes["/site.css"] = (200, {"Content-Type": "text/css; charset=utf-8"},
                                         b'body{color:#123456}@font-face{font-family:x;src:url(font.woff2) format("woff2")}@import "/deep.css";'
                                         b'.d::after{content:"</style><script>pwn()</script><style>"}')
        self.http.routes["/wide.css"] = (200, {"Content-Type": "text/css"}, b".wide{margin:0 auto}")
        document, record = self.copy()
        self.assert_inert(document)
        self.assertEqual([p for p in self.paths()], ["/page", "/site.css", "/wide.css"])
        self.assertIn("body{color:#123456}", document)
        self.assertIn('<style media="(min-width: 600px)">.wide{margin:0 auto}</style>', document)
        self.assertLess(document.index("#123456"), document.index(".wide{"))
        self.assertLess(document.index(".wide{"), document.index("#0a0b0c"))
        self.assertIn(".c{background:url(data:image/png;base64,AAAA)}", document)
        self.assertIn(".a{background:none}", document)
        self.assertIn(".b{background:none no-repeat}", document)
        self.assertIn('style="color:red;background:none"', document)
        for gone in ("@import", "/bg.png", "t.gif", "attr.gif", "font.woff2", "comment.png", "expression(", "</style><script", "<script"):
            self.assertNotIn(gone, document)
        # A stylesheet's own text can never close the <style> element it is placed in.
        self.assertIn('.d::after{content:"\\3c /style>\\3c script>pwn()\\3c /script>\\3c style>"}', document)
        self.assertEqual(document.count("<style"), document.count("</style>"))
        self.assertEqual(document.count("<style"), 3)
        self.assertEqual(record["stylesheets"], 3)

    def test_css_that_hides_a_load_from_a_simple_scan_is_still_scrubbed(self):
        # The copy's policy blocks these anyway; the scrubber is the second line.
        B = chr(92)
        for css in ("a{background:" + B + "75 rl(http://e.test/esc.png)}", "a{background:u" + B + "rl(http://e.test/u.png)}",
                    'a{background:image-set("http://e.test/s.png" 1x)}', "a{background:-webkit-image-set(url(http://e.test/w.png) 1x)}",
                    "@" + B + "69mport " + chr(34) + "http://e.test/i.css" + chr(34) + ";a{color:red}"):
            with self.subTest(css=css):
                self.assertNotIn("e.test", archive.clean_css(css))
        # Removing a comment must not join two halves into a url( a browser would load.
        self.assertEqual(archive.clean_css("a{background:u/**/rl(http://e.test/j.png)}"), "a{background:u/**/rl(http://e.test/j.png)}")
        # Text that merely mentions @import is not a rule, and real class names keep their escapes.
        self.assertEqual(archive.clean_css('.c::before{content:"@import"}.d{color:red}'), '.c::before{content:"@import"}.d{color:red}')
        tailwind = ".md" + B + ":flex{display:flex}." + B + "32xl" + B + ":text-lg{font-size:2rem}"
        self.assertEqual(archive.clean_css(tailwind), tailwind)
        self.assertEqual(archive.clean_css('@import url(http://e.test/x.css) screen;b{color:blue}'), "b{color:blue}")

    def test_strings_with_quotes_and_comment_marks_survive(self):
        # Wikipedia's icons: an inline SVG in a quoted url() with escaped quotes inside.
        svg = 'url("data:image/svg+xml;utf8,<svg xmlns=\\"http://www.w3.org/2000/svg\\" fill=\\"%23000\\"><path d=\\"m1 2\\"/></svg>")'
        css = ('.icon{background-image:' + svg + ';filter:invert(var(--x))}'
               '.q::before{content:"/* not a comment */ \\" still a string"}'
               ".s::after{content:'url(http://evil.invalid/x)'}"
               '/* a real comment with url(http://evil.invalid/y) */'
               '.after{color:#abcdef;background:url(http://evil.invalid/z.png)}')
        cleaned = archive.clean_css(css)
        self.assertIn('background-image:url("data:image/svg+xml;utf8,\\3c svg xmlns=\\"http://www.w3.org/2000/svg\\" fill=\\"%23000\\">'
                      '\\3c path d=\\"m1 2\\"/>\\3c /svg>");filter:invert(var(--x))}', cleaned)
        self.assertIn('.q::before{content:"/* not a comment */ \\" still a string"}', cleaned)
        self.assertIn(".s::after{content:'url(http://evil.invalid/x)'}", cleaned, "text inside a string is not a url")
        self.assertIn(".after{color:#abcdef;background:none}", cleaned)
        self.assertNotIn("evil.invalid/y", cleaned)
        self.assertNotIn("evil.invalid/z", cleaned)
        # Unterminated pieces drop the rest instead of swallowing markup.
        self.assertEqual(archive.clean_css('.a{color:red}.b{content:"open'), ".a{color:red}.b{content:")
        self.assertEqual(archive.clean_css('.a{color:red}/* open'), ".a{color:red}")
        self.assertEqual(archive.clean_css('.a{background:url("x'), ".a{background:")

    def test_ordinary_properties_named_like_old_script_hooks_survive(self):
        # Wikipedia: "scroll-behavior:auto" was turned into "scroll-removed(auto", an
        # open bracket that made the browser drop every rule after it.
        css = ('@media (prefers-reduced-motion:reduce){*{scroll-behavior:auto !important}}'
               '.a{overscroll-behavior:contain}.b{color:red}'
               '.c{behavior:url(x.htc);width:expression(alert(1));-moz-binding:none}')
        cleaned = archive.clean_css(css)
        self.assertIn("{*{scroll-behavior:auto !important}}.a{overscroll-behavior:contain}.b{color:red}", cleaned)
        for gone in ("behavior:none", "expression(", "-moz-binding", "x.htc"):
            self.assertNotIn(gone, cleaned.replace("scroll-behavior", ""))
        self.assertEqual(cleaned.count("("), cleaned.count(")"), "no bracket is left open")

    def test_a_mask_whose_picture_is_dropped_hides_instead_of_showing_a_box(self):
        # MDN/Wikipedia icons: a coloured square shaped by a mask picture from the site.
        css = ('.i{background-color:currentColor;-webkit-mask-image:url(/icons/x.svg);mask:url("/icons/x.svg") no-repeat}'
               '.j{background:url(/bg.png)}.k{mask-image:url("data:image/svg+xml,%3Csvg/%3E")}')
        cleaned = archive.clean_css(css)
        self.assertEqual(cleaned.count(archive._CLEAR_MASK), 2)
        self.assertIn(";mask:" + archive._CLEAR_MASK + " no-repeat}", cleaned)
        self.assertIn(".j{background:none}", cleaned)
        self.assertIn('.k{mask-image:url("data:image/svg+xml,%3Csvg/%3E")}', cleaned)
        self.assertNotIn("/icons/", cleaned)

    def test_missing_or_mislabelled_stylesheet_is_noted_not_fatal(self):
        self.http.html("/page", '<link rel="stylesheet" href="/gone.css"><link rel="stylesheet" href="/html.css"><p>' + "text " * 100 + "</p>")
        self.http.routes["/gone.css"] = (404, {"Content-Type": "text/plain"}, b"no")
        self.http.routes["/html.css"] = (200, {"Content-Type": "text/html"}, b"<html><script>pwn()</script>login</html>")
        document, record = self.copy()
        self.assert_inert(document)
        self.assertIn("2 stylesheets could not be included, so the layout may differ.", document)
        self.assertNotIn("login", document)
        self.assertEqual(record["stylesheets"], 0)


    def test_markup_built_to_stall_the_cleaner_finishes_quickly(self):
        self.http.html("/page", "<p>start</p>" + "<!--" * 150000 + "<a " * 100000 + "<![CDATA[" * 50000)
        self.http.html("/styled", '<link rel="stylesheet" href="/evil.css"><style>' + "/*" * 200000 + "</style><p>" + "text " * 100 + "</p>")
        self.http.routes["/evil.css"] = (200, {"Content-Type": "text/css"},
                                         b"a{b:url(" * 60000 + b'c{d:url("' * 30000 + b"@import " * 20000)
        self.http.html("/attrs", "<p>start</p>" + "<a " + "b=c " * 400000 + ">" + '<a b="' * 150000)
        for path in ("/page", "/styled", "/attrs"):
            started = time.monotonic()
            document, _ = self.copy(path)
            self.assertLess(time.monotonic() - started, 15, path)
            self.assert_inert(document)
            self.assertIn("start" if path != "/styled" else "text text", document)
        # A flood of fragments is refused instead of filling memory.
        self.http.html("/flood", "<" * (2 * 1024 * 1024))
        started = time.monotonic()
        with self.assertRaises(archive.ArchiveError) as raised:
            archive.build_copy(BASE_URL + "/flood")
        self.assertEqual(raised.exception.code, "too_large")
        self.assertLess(time.monotonic() - started, 15)
        started = time.monotonic()
        for hostile in ("url(" * 250000, 'url("' * 200000, "/*" * 500000, "@import" * 150000, "expression" + " " * 900000,
                        "url(" + " " * 900000, "<" * 900000):
            archive.clean_css(hostile)
        self.assertLess(time.monotonic() - started, 5)


class ImageTests(ArchiveCase):
    def test_pictures_are_inlined_including_lazy_and_srcset(self):
        self.http.html("/page", f"""<p>{'text ' * 100}</p><img src="/a.jpg" alt="A" width="640" height="480" class="hero" loading="lazy">
            <img src="{TINY_GIF}" data-src="/lazy.png" alt="Lazy"><noscript><img src="/lazy.png" alt="Lazy"></noscript>
            <picture><source srcset="/big.avif" type="image/avif"><img srcset="/s1.webp 1x, /s2.webp 2x" alt="Set"></picture>
            <img src="http://cdn.fixture.test/c.gif"><img src="/logo.svg" alt="Logo"><img src="{TINY_GIF}" alt="Inline">
            <img src="/missing.jpg" alt="Chart of things"><img src="/fake.jpg"><img src="/a.jpg" alt="Again">
            <img src="javascript:pwn()" alt=""><img alt="no source">""")
        self.image("/a.jpg", JPEG, "image/jpeg")
        self.image("/lazy.png", PNG, "image/png")
        self.image("/s1.webp", WEBP, "image/webp")
        self.image("/c.gif", GIF, "application/octet-stream")   # the bytes decide, not the label
        self.image("/logo.svg", SVG, "image/svg+xml")
        self.http.routes["/missing.jpg"] = (404, {"Content-Type": "text/plain"}, b"gone")
        self.image("/fake.jpg", b"<html>not an image</html>" * 50, "image/jpeg")
        document, record = self.copy()
        self.assert_inert(document)
        self.assertIn(f'<img alt="A" width="640" height="480" class="hero" src="data:image/jpeg;base64,{b64(JPEG)}">', document)
        self.assertIn(f'<img alt="Lazy" src="data:image/png;base64,{b64(PNG)}">', document)
        self.assertIn(f'src="data:image/webp;base64,{b64(WEBP)}"', document)
        self.assertIn(f'src="data:image/gif;base64,{b64(GIF)}"', document)
        self.assertIn(f'<img alt="Logo" src="data:image/svg+xml;base64,{b64(SVG)}">', document)
        self.assertIn(f'<img alt="Inline" src="{TINY_GIF}">', document)
        self.assertIn("<span>[Chart of things]</span>", document)
        paths = self.paths()
        self.assertEqual(paths, ["/page", "/a.jpg", "/lazy.png", "/s1.webp", "/c.gif", "/logo.svg", "/missing.jpg", "/fake.jpg"])
        self.assertEqual(document.count(b64(JPEG)), 2)       # used twice, fetched once
        self.assertEqual(document.count(b64(PNG)), 1)        # lazy image and its <noscript> twin are one picture
        self.assertEqual(record["images"], 7)
        self.assertEqual(record["imagesLeftOut"], 2)
        self.assertIn("2 pictures could not be fetched.", document)
        self.assertFalse(record["limited"])

    def test_only_the_first_forty_pictures_are_saved(self):
        tags = "".join(f'<img src="/i{n}.gif" alt="p{n}">' for n in range(45))
        self.http.html("/page", "<p>" + "text " * 100 + "</p>" + tags)
        for n in range(45):
            self.image(f"/i{n}.gif", GIF + bytes([n]), "image/gif")
        document, record = self.copy()
        self.assertEqual(len([p for p in self.paths() if p.startswith("/i")]), 40)
        self.assertEqual(record["images"], 40)
        self.assertEqual(record["imagesLeftOut"], 5)
        self.assertIn("Only the first 40 pictures were saved; 5 more were left out.", document)
        self.assertIn("<span>[p44]</span>", document)

    def test_oversized_pictures_and_the_file_cap_drop_pictures_not_the_copy(self):
        self.http.html("/page", "<p>" + "text " * 100 + '</p><img src="/huge.jpg" alt="Huge"><img src="/ok.jpg">')
        self.image("/huge.jpg", JPEG[:4] + b"x" * archive.IMAGE_LIMIT, "image/jpeg")       # one byte over 4 MB
        self.image("/ok.jpg", JPEG, "image/jpeg")
        document, record = self.copy()
        self.assertEqual((record["images"], record["imagesLeftOut"]), (1, 1))
        self.assertIn("1 picture was too big to keep and left out.", document)
        self.assertIn("<span>[Huge]</span>", document)

        tags = "".join(f'<img src="/f{n}.jpg">' for n in range(6))
        self.http.html("/full", "<p>" + "text " * 100 + "</p>" + tags)
        for n in range(6):
            self.image(f"/f{n}.jpg", JPEG[:4] + bytes([n]) * 6000, "image/jpeg")
        with patch.object(archive, "FILE_LIMIT", 32000):
            data, record = archive.build_copy(BASE_URL + "/full")
        self.assertLessEqual(len(data), 32000)
        self.assertEqual(record["bytes"], len(data))
        self.assertGreaterEqual(record["images"], 1)
        self.assertEqual(record["images"] + record["imagesLeftOut"], 6)
        self.assertIn(b"too big to keep and left out.", data)

    def test_a_full_file_fetches_no_more_pictures(self):
        tags = "".join(f'<img src="/g{n}.jpg">' for n in range(4))
        self.http.html("/text-only-fits", "<p>" + "text " * 400 + "</p>" + tags)
        for n in range(4):
            self.image(f"/g{n}.jpg", JPEG[:4] + bytes([n]) * 6000, "image/jpeg")
        with patch.object(archive, "FILE_LIMIT", 9000):
            data, record = archive.build_copy(BASE_URL + "/text-only-fits")
        self.assertEqual((record["images"], record["imagesLeftOut"]), (0, 4))
        self.assertEqual([p for p in self.paths() if p.startswith("/g")], [], "pictures that cannot fit are not downloaded")


class BoundaryTests(ArchiveCase):
    def test_redirect_is_followed_and_links_use_the_final_address(self):
        self.http.routes["/old"] = (302, {"Location": CDN + "/new/page"}, b"")
        self.http.html("/new/page", '<title>Moved</title><p>' + "text " * 100 + '</p><a href="next">Next</a><img src="pic.jpg" alt="Pic">')
        self.image("/new/pic.jpg", JPEG, "image/jpeg")
        document, record = self.copy("/old")
        self.assertIn(f'<a href="{CDN}/new/next" target="_blank"', document)
        self.assertIn(b64(JPEG), document)
        self.assertEqual(record["finalUrl"], CDN + "/new/page")
        self.assertEqual(record["url"], BASE_URL + "/old")
        self.assertIn(f'href="{BASE_URL}/old"', document)
        self.assertEqual(self.paths(), ["/old", "/new/page", "/new/pic.jpg"])

    def test_base_href_applies_only_when_it_is_a_web_address(self):
        self.http.html("/page", f'<base href="{CDN}/assets/"><p>' + "text " * 100 + '</p><a href="doc">Doc</a><img src="b.png">')
        self.image("/assets/b.png", PNG, "image/png")
        document, _ = self.copy()
        self.assertIn(f'<a href="{CDN}/assets/doc"', document)
        self.assertIn(b64(PNG), document)
        self.http.html("/bad", '<base href="javascript:pwn()//"><a href="doc">Doc</a>')
        document, _ = self.copy("/bad")
        self.assertIn(f'<a href="{BASE_URL}/doc"', document)
        self.assert_inert(document)

    def test_private_addresses_are_refused_without_connecting(self):
        self.http.dns["internal.fixture.test"] = ["10.0.0.5"]
        self.http.dns["mixed.fixture.test"] = ["93.184.216.34", "192.168.1.10"]
        for url in ("http://127.0.0.1:8080/admin", "http://app.localhost/", "http://[::1]/", "http://169.254.169.254/latest/meta-data/",
                    "http://internal.fixture.test/", "http://mixed.fixture.test/", "http://192.168.0.1/router"):
            with self.subTest(url=url):
                with self.assertRaises(archive.ArchiveError) as raised:
                    archive.build_copy(url)
                self.assertEqual(raised.exception.code, "blocked_url")
        for url in ("file:///etc/passwd", "ftp://metadata.fixture.test/", "javascript:alert(1)", "", "http://localhost/",
                    "http://user:pw@metadata.fixture.test/"):
            with self.subTest(url=url):
                with self.assertRaises(archive.ArchiveError) as raised:
                    archive.build_copy(url)
                self.assertEqual(raised.exception.code, "invalid_url")
        self.assertEqual(self.http.connections, [])
        self.assertEqual(self.http.requests, [])

    def test_private_resources_and_redirects_are_left_out(self):
        self.http.dns["internal.fixture.test"] = ["10.0.0.5"]
        self.http.html("/page", '<link rel="stylesheet" href="http://internal.fixture.test/s.css"><p>' + "text " * 100 + """</p>
            <img src="http://internal.fixture.test/secret.png" alt="Internal"><img src="http://127.0.0.1/x.png"><img src="/hop.png"><img src="/ok.jpg">""")
        self.http.routes["/hop.png"] = (302, {"Location": "http://127.0.0.1/internal.png"}, b"")
        self.image("/ok.jpg", JPEG, "image/jpeg")
        document, record = self.copy()
        self.assertEqual((record["images"], record["imagesLeftOut"]), (1, 3))
        self.assertEqual(self.paths(), ["/page", "/hop.png", "/ok.jpg"])
        self.assertTrue(all(address == "93.184.216.34" for address, _, _ in self.http.connections))
        self.http.routes["/away"] = (302, {"Location": "http://internal.fixture.test/"}, b"")
        with self.assertRaises(archive.ArchiveError) as raised:
            archive.build_copy(BASE_URL + "/away")
        self.assertEqual(raised.exception.code, "blocked_url")

    def test_page_size_limit_is_three_megabytes_for_copies_only(self):
        filler = b"<p>" + b"word " * 300000 + b"</p>"            # ~1.5 MB: over the preview limit, under the copy limit
        self.assertGreater(len(filler), safe_http.HTML_LIMIT)
        self.http.routes["/long"] = (200, {"Content-Type": "text/html"}, filler)
        _, record = archive.build_copy(BASE_URL + "/long")
        self.assertGreater(record["bytes"], safe_http.HTML_LIMIT)
        self.assertEqual(safe_http.HTML_LIMIT, 1024 * 1024)       # link previews keep their own limit
        self.http.routes["/huge"] = (200, {"Content-Type": "text/html"}, b"x" * (archive.PAGE_LIMIT + 1))
        with self.assertRaises(archive.ArchiveError) as raised:
            archive.build_copy(BASE_URL + "/huge")
        self.assertEqual(raised.exception.code, "too_large")
        self.assertEqual(archive.PAGE_LIMIT, 3 * 1024 * 1024)
        self.assertEqual(archive.FILE_LIMIT, 15 * 1024 * 1024)

    def test_non_html_and_site_errors_fail_with_fixed_codes(self):
        self.http.routes["/doc.pdf"] = (200, {"Content-Type": "application/pdf"}, b"%PDF-1.7 synthetic")
        self.http.routes["/gone"] = (404, {"Content-Type": "text/html"}, b"<h1>SECRET site error text</h1>")
        for path, code in (("/doc.pdf", "not_html"), ("/gone", "http_error")):
            with self.subTest(path=path):
                with self.assertRaises(archive.ArchiveError) as raised:
                    archive.build_copy(BASE_URL + path)
                self.assertEqual(raised.exception.code, code)
                self.assertNotIn("SECRET", str(raised.exception))

    def test_time_budget_stops_fetching_but_keeps_the_copy(self):
        self.http.html("/page", "<p>" + "text " * 100 + '</p><img src="/slow.jpg" alt="Slow"><img src="/late.jpg" alt="Late">')

        def slow(handler):
            time.sleep(1.2)
            handler.send_response(200)
            handler.send_header("Content-Type", "image/jpeg")
            handler.send_header("Content-Length", str(len(JPEG)))
            handler.end_headers()
            handler.wfile.write(JPEG)
        self.http.routes["/slow.jpg"] = slow
        self.image("/late.jpg", JPEG, "image/jpeg")
        started = time.monotonic()
        document, record = archive.build_copy(BASE_URL + "/page", deadline=time.monotonic() + 1.6)
        self.assertLess(time.monotonic() - started, 4)
        self.assertEqual(record["imagesLeftOut"], 2 - record["images"])
        self.assertNotIn("/late.jpg", self.paths())
        self.assertIn("<span>[Late]</span>", document.decode())


class StoreTests(ArchiveCase):
    def page(self, path="/page", text="Stored page"):
        self.http.html(path, f"<title>{text}</title><p>" + "text " * 100 + "</p>")

    def test_copy_is_one_file_named_by_the_links_identity(self):
        self.page()
        record = archive.save_copy(BASE_URL + "/page")
        key = archive.copy_key(BASE_URL + "/page")
        self.assertRegex(key, r"^[0-9a-f]{32}$")
        self.assertEqual(key, archive.copy_key("HTTP://Metadata.Fixture.Test:80/page"))
        self.assertNotEqual(key, archive.copy_key(BASE_URL + "/page?x=1"))
        self.assertEqual(sorted(os.listdir(self.store)), [key + ".html", key + ".json"])
        data = (self.store / (key + ".html")).read_bytes()
        self.assertTrue(data.startswith(b"<!DOCTYPE html>"))
        self.assertEqual(record["key"], key)
        self.assertEqual(record["status"], "saved")
        self.assertEqual(record["bytes"], len(data))
        self.assertEqual(record["title"], "Stored page")
        self.assertEqual(record["url"], BASE_URL + "/page")
        self.assertRegex(record["savedAt"], r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$")
        self.assertEqual(archive.read_record(key), record)
        self.assertEqual(archive.summary(), {"count": 1, "bytes": len(data)})
        stored = json.loads((self.store / (key + ".json")).read_text())
        self.assertEqual(stored["version"], 1)

    def test_delete_removes_the_copy_and_its_record(self):
        self.page()
        archive.save_copy(BASE_URL + "/page")
        self.assertTrue(archive.delete_for_url("http://METADATA.fixture.test/page"))
        self.assertEqual(os.listdir(self.store), [])
        self.assertFalse(archive.delete_for_url(BASE_URL + "/page"))
        self.assertIsNone(archive.read_record(archive.copy_key(BASE_URL + "/page")))
        self.assertEqual(archive.summary(), {"count": 0, "bytes": 0})
        for bad in ("../x", "", "A" * 32, "0" * 31, None, "0" * 32 + "/"):
            self.assertFalse(archive.delete_copy(bad))
            self.assertIsNone(archive.read_record(bad))

    def test_failed_save_leaves_no_partial_file(self):
        self.page()
        with patch.object(archive.os, "replace", side_effect=OSError("disk full")):
            with self.assertRaises(archive.ArchiveError) as raised:
                archive.save_copy(BASE_URL + "/page")
        self.assertEqual(raised.exception.code, "internal_error")
        self.assertEqual(os.listdir(self.store), [])


class QueueTests(ArchiveCase):
    def page(self, path, text="Queued page"):
        self.http.html(path, f"<title>{text}</title><p>" + "text " * 100 + "</p>")

    def test_request_queues_then_reports_the_saved_copy(self):
        self.page("/page")
        first = archive.request_copy(BASE_URL + "/page")
        key = archive.copy_key(BASE_URL + "/page")
        self.assertEqual(first["key"], key)
        self.assertIn(first["status"], ("queued", "saving"))
        self.assertTrue(archive.wait_idle(10))
        saved = archive.state(key)
        self.assertEqual(saved["status"], "saved")
        self.assertEqual(saved["title"], "Queued page")
        # Asking again does not fetch again; an update does.
        self.assertEqual(archive.request_copy(BASE_URL + "/page")["status"], "saved")
        self.assertEqual(self.paths().count("/page"), 1)
        self.page("/page", "Changed page")
        self.assertIn(archive.request_copy(BASE_URL + "/page", refresh=True)["status"], ("queued", "saving"))
        self.assertTrue(archive.wait_idle(10))
        self.assertEqual(archive.state(key)["title"], "Changed page")
        self.assertEqual(self.paths().count("/page"), 2)
        self.assertEqual(archive.state("f" * 32), {"key": "f" * 32, "status": "none"})

    def test_failures_are_reported_and_a_failed_update_keeps_the_old_copy(self):
        self.http.routes["/gone"] = (404, {"Content-Type": "text/html"}, b"gone")
        self.http.routes["/huge"] = (200, {"Content-Type": "text/html"}, b"x" * (archive.PAGE_LIMIT + 1))
        for path in ("/gone", "/huge"):
            archive.request_copy(BASE_URL + path)
        self.assertTrue(archive.wait_idle(10))
        self.assertEqual(archive.state(archive.copy_key(BASE_URL + "/gone")),
                         {"key": archive.copy_key(BASE_URL + "/gone"), "status": "failed", "error": "http_error"})
        self.assertEqual(archive.state(archive.copy_key(BASE_URL + "/huge"))["status"], "too_large")
        self.assertEqual(os.listdir(self.store), [])
        for url, code in (("http://127.0.0.1/x", "blocked_url"), ("notaurl", "invalid_url"), ("file:///c:/x", "invalid_url")):
            self.assertEqual(archive.request_copy(url), {"key": "", "status": "failed", "error": code})

        self.page("/page", "First version")
        archive.request_copy(BASE_URL + "/page")
        self.assertTrue(archive.wait_idle(10))
        key = archive.copy_key(BASE_URL + "/page")
        before = (self.store / (key + ".html")).read_bytes()
        self.http.routes["/page"] = (500, {"Content-Type": "text/html"}, b"down")
        archive.request_copy(BASE_URL + "/page", refresh=True)
        self.assertTrue(archive.wait_idle(10))
        failed = archive.state(key)
        self.assertEqual((failed["status"], failed["error"]), ("failed", "http_error"))
        self.assertEqual(failed["previous"]["bytes"], len(before))
        self.assertEqual((self.store / (key + ".html")).read_bytes(), before)
        # Without an update request the earlier copy is still the answer.
        self.assertEqual(archive.request_copy(BASE_URL + "/page")["status"], "saved")

    def test_same_link_is_fetched_once_and_one_site_one_page_at_a_time(self):
        active, peak, lock = [0], [0], threading.Lock()

        def slow(handler):
            with lock:
                active[0] += 1
                peak[0] = max(peak[0], active[0])
            time.sleep(0.15)
            with lock:
                active[0] -= 1
            body = b"<title>Slow</title><p>" + b"text " * 100 + b"</p>"
            handler.send_response(200)
            handler.send_header("Content-Type", "text/html")
            handler.send_header("Content-Length", str(len(body)))
            handler.end_headers()
            handler.wfile.write(body)
        for n in range(4):
            self.http.routes[f"/slow{n}"] = slow
        for n in range(4):
            archive.request_copy(BASE_URL + f"/slow{n}")
        duplicate = archive.request_copy("http://METADATA.fixture.test/slow0")
        self.assertIn(duplicate["status"], ("queued", "saving"))
        self.assertTrue(archive.wait_idle(15))
        self.assertEqual(peak[0], 1)
        self.assertEqual(sorted(self.paths()), ["/slow0", "/slow1", "/slow2", "/slow3"])
        self.assertEqual(archive.summary()["count"], 4)

    def test_a_full_queue_answers_busy_instead_of_growing(self):
        release = threading.Event()

        def held(handler):
            release.wait(10)
            handler.send_response(404)
            handler.send_header("Content-Length", "0")
            handler.end_headers()
        for n in range(8):
            self.http.routes[f"/held?n={n}"] = held
        try:
            with patch.object(archive, "QUEUE_LIMIT", 2):
                results = [archive.request_copy(f"{BASE_URL}/held?n={n}") for n in range(8)]
                # Same site: one is being fetched, the rest wait or are turned away.
                busy = [r for r in results if r.get("error") == "busy"]
                self.assertGreaterEqual(len(busy), 3)
                self.assertTrue(all(r["status"] == "failed" for r in busy))
        finally:
            release.set()
        self.assertTrue(archive.wait_idle(15))


def saved_post(number=1, **changes):
    post = {
        "id": f"copy-fixture-{number}", "url": f"{BASE_URL}/post/{number}", "source": "manual", "platform": "web",
        "domain": "metadata.fixture.test", "status": "inbox", "categories": [], "tags": [], "projectIds": [],
        "createdAt": "2026-10-08T10:00:00Z", "updatedAt": "2026-10-08T10:00:00Z", "metadataStatus": "none",
    }
    post.update(changes)
    return post


@unittest.skipIf(dashboard is None, "Flask is not installed")
class RouteTests(ArchiveCase):
    def setUp(self):
        super().setUp()
        storage.init_db()
        self.client = dashboard.app.test_client()
        self.http.html("/page", '<title>Route page</title><link rel="stylesheet" href="/site.css"><p class="lead">'
                                + "text " * 100 + '</p><script>window.pwned = 1</script><img src="/a.jpg" alt="A">')
        self.http.routes["/site.css"] = (200, {"Content-Type": "text/css"}, b".lead{color:#123456}")
        self.image("/a.jpg", JPEG, "image/jpeg")
        self.url = BASE_URL + "/page"
        self.key = archive.copy_key(self.url)

    def save(self, url=None):
        response = self.client.post("/api/archive", json={"url": url or self.url})
        self.assertIn(response.status_code, (200, 202), response.get_data(as_text=True))
        self.assertTrue(archive.wait_idle(10))
        return response

    def test_other_sites_cannot_frame_the_app_or_embed_its_files(self):
        for path in ("/", "/add", "/library/settings", "/api/archive", f"/archive/{self.key}.mp4"):   # /thumb/ is the same hook; its folder is outside the fixture
            response = self.client.get(path)
            with self.subTest(path=path):
                self.assertEqual(response.headers.get("X-Frame-Options"), "SAMEORIGIN")
                self.assertIn("frame-ancestors 'self'", response.headers.get("Content-Security-Policy", ""))
                self.assertEqual(response.headers.get("Cross-Origin-Resource-Policy"), "same-origin")

    def test_save_poll_and_view(self):
        first = self.client.post("/api/archive", json={"url": self.url})
        self.assertEqual(first.status_code, 202)
        self.assertEqual(first.json["key"], self.key)
        self.assertIn(first.json["status"], ("queued", "saving"))
        self.assertTrue(archive.wait_idle(10))
        polled = self.client.get(f"/api/archive?keys={self.key},{'f' * 32}")
        self.assertEqual(polled.status_code, 200)
        self.assertEqual(polled.json["copies"]["f" * 32], {"key": "f" * 32, "status": "none"})
        copy = polled.json["copies"][self.key]
        self.assertEqual((copy["status"], copy["title"], copy["images"]), ("saved", "Route page", 1))
        again = self.client.post("/api/archive", json={"url": self.url})
        self.assertEqual((again.status_code, again.json["status"]), (200, "saved"))
        self.assertEqual(self.paths().count("/page"), 1)
        update = self.client.post("/api/archive", json={"url": self.url, "refresh": True})
        self.assertEqual(update.status_code, 202)
        self.assertTrue(archive.wait_idle(10))
        self.assertEqual(self.paths().count("/page"), 2)

        stored = (self.store / (self.key + ".html")).read_bytes()
        view = self.client.get(f"/archive/{self.key}")
        self.assertEqual(view.status_code, 200)
        self.assertEqual(view.data, stored)
        self.assertEqual(view.headers["Content-Type"], "text/html; charset=utf-8")
        self.assertEqual(view.headers["Content-Security-Policy"],
                         "sandbox allow-popups allow-popups-to-escape-sandbox; default-src 'none'; img-src data:; media-src http://localhost/archive/; "
                         "style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'")
        self.assertNotIn("allow-scripts", view.headers["Content-Security-Policy"])
        self.assertNotIn("allow-same-origin", view.headers["Content-Security-Policy"])
        self.assertEqual(view.headers["X-Content-Type-Options"], "nosniff")
        self.assertEqual(view.headers["Cross-Origin-Resource-Policy"], "same-origin")
        self.assertEqual(view.headers["X-Frame-Options"], "SAMEORIGIN")
        self.assertEqual(view.headers["Referrer-Policy"], "no-referrer")
        self.assertEqual(view.headers["Cache-Control"], "no-store")
        self.assert_inert(view.get_data(as_text=True))
        self.assertIn(".lead{color:#123456}", view.get_data(as_text=True))

        plain = self.client.get(f"/archive/{self.key}?view=plain")
        text = plain.get_data(as_text=True)
        self.assertEqual(plain.headers["Content-Security-Policy"], view.headers["Content-Security-Policy"])
        self.assertNotIn("#123456", text)
        self.assertIn("*{all:revert!important}", text)
        self.assertEqual(text.count("<style"), 1)
        self.assertEqual(body_of(text), body_of(stored.decode()))
        self.assert_inert(text)

        framed = self.client.get(f"/archive/{self.key}?banner=0&view=plain").get_data(as_text=True)
        self.assertIn("<style>[data-sbm-saved-copy]{display:none!important}</style></head>", framed)
        self.assertIn("*{all:revert!important}", framed)
        self.assertEqual(body_of(framed), body_of(stored.decode()))
        self.assertNotIn("display:none!important", view.get_data(as_text=True))
        self.assert_inert(framed)

        total = self.client.get("/api/archive")
        self.assertEqual(total.json, {"ok": True, "enabled": True, "count": 1, "bytes": len(stored)})

    def test_switched_off_nothing_is_fetched(self):
        with patch.object(archive, "ENABLED", False):
            refused = self.client.post("/api/archive", json={"url": self.url})
            self.assertEqual((refused.status_code, refused.json["error"]), (503, "disabled"))
            self.assertFalse(self.client.get("/api/archive").json["enabled"])
        self.assertEqual(self.http.requests, [])
        self.assertEqual(os.listdir(self.store), [])

    def test_bad_requests_are_refused(self):
        post = lambda **kw: self.client.post("/api/archive", **kw)
        for body in ({}, {"url": 5}, {"url": ""}, {"url": self.url, "refresh": "yes"}, {"url": self.url, "extra": 1},
                     {"url": "x" * 5000}, {"url": "notaurl"}, {"url": "http://127.0.0.1:5001/api/library"},
                     {"url": "file:///c:/Users/x/saved_posts.db"}):
            with self.subTest(body=str(body)[:60]):
                response = post(json=body)
                self.assertEqual(response.status_code, 400)
                self.assertFalse(response.json["ok"])
        self.assertEqual(post(json={"url": "http://192.168.1.1/"}).json["error"], "blocked_url")
        self.assertEqual(post(data="[]", content_type="application/json").status_code, 400)
        self.assertEqual(post(data="url=" + self.url, content_type="application/x-www-form-urlencoded").status_code, 415)
        self.assertEqual(post(data=json.dumps({"url": self.url}), content_type="text/plain").status_code, 415)
        for headers in ({"Origin": "http://evil.invalid"}, {"Origin": "null"}, {"Sec-Fetch-Site": "cross-site"}, {"Sec-Fetch-Site": "same-site"}):
            with self.subTest(headers=headers):
                self.assertEqual(post(json={"url": self.url}, headers=headers).status_code, 403)
                self.assertEqual(self.client.delete(f"/api/archive/{self.key}", headers=headers).status_code, 403)
        self.assertEqual(post(json={"url": self.url}, headers={"Host": "evil.invalid"}).status_code, 403)
        for keys in ("../../app.py", "A" * 32, "0" * 31, ",".join(["0" * 32] * 201)):
            self.assertEqual(self.client.get("/api/archive", query_string={"keys": keys}).status_code, 400, keys[:40])
        self.assertEqual(self.http.requests, [])
        self.assertEqual(os.listdir(self.store), [])

    def test_viewer_serves_only_stored_copies(self):
        self.save()
        for path in ("/archive/" + "f" * 32, "/archive/ABC", "/archive/" + self.key + ".json", "/archive/" + self.key + ".html",
                     "/archive/..%2F..%2Fapp.py", "/archive/" + self.key + "/x", "/archive/" + self.key.upper()):
            with self.subTest(path=path):
                response = self.client.get(path)
                self.assertEqual(response.status_code, 404)
                self.assertNotIn(b"Route page", response.data)

    def test_delete_removes_a_copy_even_while_it_is_being_made(self):
        self.save()
        response = self.client.delete(f"/api/archive/{self.key}")
        self.assertEqual(response.json, {"ok": True, "deleted": True})
        self.assertEqual(self.client.get(f"/archive/{self.key}").status_code, 404)
        self.assertEqual(self.client.delete(f"/api/archive/{self.key}").json, {"ok": True, "deleted": False})
        self.assertEqual(self.client.delete("/api/archive/nope").status_code, 400)

        release = threading.Event()

        def slow(handler):
            release.wait(10)
            body = b"<title>Slow</title><p>" + b"text " * 100 + b"</p>"
            handler.send_response(200)
            handler.send_header("Content-Type", "text/html")
            handler.send_header("Content-Length", str(len(body)))
            handler.end_headers()
            handler.wfile.write(body)
        self.http.routes["/slow"] = slow
        try:
            self.assertEqual(self.client.post("/api/archive", json={"url": BASE_URL + "/slow"}).status_code, 202)
            for _ in range(200):
                if self.http.requests and self.http.requests[-1][0] == "/slow":
                    break
                time.sleep(0.01)
            self.client.delete(f"/api/archive/{archive.copy_key(BASE_URL + '/slow')}")
        finally:
            release.set()
        self.assertTrue(archive.wait_idle(10))
        self.assertEqual(os.listdir(self.store), [])
        self.assertEqual(archive.state(archive.copy_key(BASE_URL + "/slow"))["status"], "none")

    def test_a_copy_asked_for_again_after_a_delete_is_kept_and_a_deleted_queued_one_is_never_fetched(self):
        release = threading.Event()

        def slow(handler):
            release.wait(10)
            body = b"<title>Slow</title><p>" + b"text " * 100 + b"</p>"
            handler.send_response(200)
            handler.send_header("Content-Type", "text/html")
            handler.send_header("Content-Length", str(len(body)))
            handler.end_headers()
            handler.wfile.write(body)
        for n in range(archive.WORKERS):
            self.http.routes[f"/busy/{n}"] = slow
        self.http.html("/waiting", "<title>Waiting</title><p>words</p>")
        try:
            for n in range(archive.WORKERS):
                archive.request_copy(f"{BASE_URL}/busy/{n}")
            for _ in range(300):
                if len([r for r in self.http.requests if r[0].startswith("/busy/")]) == archive.WORKERS:
                    break
                time.sleep(0.01)
            archive.request_copy(BASE_URL + "/waiting")            # queued behind the busy workers
            archive.remove(archive.copy_key(BASE_URL + "/waiting"))
            busy = archive.copy_key(BASE_URL + "/busy/0")
            archive.remove(busy)                                   # deleted while saving...
            self.assertEqual(archive.request_copy(BASE_URL + "/busy/0")["status"], "saving")   # ...then added back
        finally:
            release.set()
        self.assertTrue(archive.wait_idle(10))
        self.assertNotIn("/waiting", self.paths(), "a copy deleted while queued is never fetched")
        self.assertEqual(archive.state(busy)["status"], "saved", "the copy asked for again is kept")

    def test_deleting_a_link_deletes_its_copy(self):
        posts = [saved_post(1), saved_post(2), saved_post(3)]
        for post in posts:
            self.http.html(f"/post/{post['id'][-1]}", "<title>Post</title><p>" + "text " * 100 + "</p>")
        saved = self.client.post("/api/library", json={"posts": posts, "deletedUrls": []})
        self.assertEqual((saved.status_code, saved.json["rejected"]), (200, []))
        for post in posts:
            self.save(post["url"])
        self.assertEqual(archive.summary()["count"], 3)
        # Another spelling of the same link still finds its copy.
        gone = self.client.post("/api/library", json={"posts": [], "deletedUrls": ["HTTP://Metadata.Fixture.Test:80/post/1"]})
        self.assertEqual(gone.status_code, 200)
        self.assertIsNone(archive.read_record(archive.copy_key(posts[0]["url"])))
        self.assertEqual(archive.summary()["count"], 2)
        # Undoing an import purges the link, and its copy with it.
        self.client.post("/api/library", json={"posts": [], "deletedUrls": [], "purgeUrls": [posts[1]["url"]]})
        self.assertIsNone(archive.read_record(archive.copy_key(posts[1]["url"])))
        self.assertIsNotNone(archive.read_record(archive.copy_key(posts[2]["url"])))
        # A problem removing the file never fails the library save.
        with patch.object(archive, "remove_for_url", side_effect=OSError("locked")):
            kept = self.client.post("/api/library", json={"posts": [], "deletedUrls": [posts[2]["url"]]})
        self.assertEqual((kept.status_code, kept.json["ok"]), (200, True))
        self.assertIn(posts[2]["url"], kept.json["deletedUrls"])

    def test_backup_with_copies_is_an_opt_in_zip(self):
        import io
        import zipfile
        posts = [saved_post(1, title="First"), saved_post(2, title="Second")]
        self.http.html("/post/1", "<title>First &lt;b&gt;page&lt;/b&gt; &amp; more</title><p>" + "text " * 100 + "</p>")
        self.http.html("/post/2", "<title>Second page</title><p>" + "text " * 100 + '</p><img src="/a.jpg">')
        self.client.post("/api/library", json={"posts": posts, "deletedUrls": []})
        for post in posts:
            self.save(post["url"])
        # The ordinary backup stays a JSON document without any copy in it.
        plain = self.client.post("/api/backup/export", json={"confirm": True}).json
        self.assertEqual(plain["recordCount"], 2)
        self.assertNotIn("Saved copy of", plain["content"])
        for body in ({}, {"confirm": False}, {"confirm": True, "extra": 1}):
            self.assertEqual(self.client.post("/api/archive/export", json=body).status_code, 400)
        self.assertEqual(self.client.post("/api/archive/export", json={"confirm": True}, headers={"Origin": "http://evil.invalid"}).status_code, 403)
        self.assertIn(self.client.get("/api/archive/export").status_code, (404, 405))   # never a plain link

        response = self.client.post("/api/archive/export", json={"confirm": True})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.mimetype, "application/zip")
        self.assertRegex(response.headers["Content-Disposition"], r'^attachment; filename="saved-posts-with-copies-[0-9T-]+\.zip"$')
        bundle = zipfile.ZipFile(io.BytesIO(response.data))
        self.assertIsNone(bundle.testzip())
        keys = [archive.copy_key(post["url"]) for post in posts]
        expected = {"library.json", "index.html"} | {f"copies/{key}.{kind}" for key in keys for kind in ("html", "json")}
        self.assertEqual(set(bundle.namelist()), expected)
        for key in keys:
            self.assertEqual(bundle.read(f"copies/{key}.html"), (self.store / f"{key}.html").read_bytes())
        library = json.loads(bundle.read("library.json"))
        self.assertEqual((library["format"], library["recordCount"]), ("saved-posts-library", 2))
        from library_backup import validate_backup
        validate_backup(bundle.read("library.json").decode())
        index = bundle.read("index.html").decode()
        self.assertIn("default-src 'none'; style-src 'unsafe-inline'", index)
        self.assertNotIn("<b>page", index)
        self.assertNotIn("<script", index)
        self.assertIn(f'<a href="copies/{keys[0]}.html">First &lt;b&gt;page&lt;/b&gt; &amp; more</a>', index)
        self.assertIn("2 saved copies exported", index)
        # With nothing saved the zip is still a valid backup.
        for key in keys:
            archive.remove(key)
        empty = zipfile.ZipFile(io.BytesIO(self.client.post("/api/archive/export", json={"confirm": True}).data))
        self.assertEqual(set(empty.namelist()), {"library.json", "index.html"})

    def _export(self):
        response = self.client.post("/api/archive/export", json={"confirm": True})
        self.assertEqual(response.status_code, 200)
        return response.data

    def _import(self, data, content_type="application/zip", **kw):
        return self.client.post("/api/archive/import", data=data, content_type=content_type, **kw)

    def test_restore_copies_from_the_zip(self):
        import io
        import zipfile
        posts = [saved_post(n) for n in (41, 42, 43)]
        for n in (41, 42, 43):
            self.http.html(f"/post/{n}", f"<title>Post {n}</title><p>" + "text " * 100 + "</p>")
        self.assertEqual(self.client.post("/api/library", json={"posts": posts, "deletedUrls": []}).json["rejected"], [])
        for post in posts:
            self.save(post["url"])
        keys = [archive.copy_key(post["url"]) for post in posts]
        original = {key: (self.store / f"{key}.html").read_bytes() for key in keys}
        data = self._export()
        # Copy 1 is lost, copy 2 is still here, link 3 is no longer in the library.
        archive.remove(keys[0])
        self.client.post("/api/library", json={"posts": [], "deletedUrls": [posts[2]["url"]]})
        self.assertIsNone(archive.read_record(keys[2]))
        before2 = (self.store / f"{keys[1]}.html").stat().st_mtime_ns
        response = self._import(data)
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        result = response.json
        self.assertEqual((result["already"], result["notInLibrary"], result["invalid"]), (1, 1, 0))
        self.assertEqual([item["key"] for item in result["restored"]], [keys[0]])
        restored = result["restored"][0]
        self.assertEqual(restored["url"], posts[0]["url"])
        # A restored page is rebuilt through the cleaner (owner, 2026-10-09): same content, freshly checked markup.
        stored = (self.store / f"{keys[0]}.html").read_bytes()
        self.assertEqual(restored["bytes"], len(stored))
        self.assertRegex(restored["savedAt"], r"^\d{4}-")
        self.assertEqual(stored, archive.reclean_copy(original[keys[0]], posts[0]["url"], keys[0]))
        self.assertEqual(archive.reclean_copy(stored, posts[0]["url"], keys[0]), stored, "cleaning twice changes nothing")
        self.assertIn(b"text text text", stored)
        self.assertIn(b'data-sbm-saved-copy="1"', stored)
        self.assertEqual((self.store / f"{keys[1]}.html").stat().st_mtime_ns, before2, "an existing copy is never replaced")
        self.assertFalse((self.store / f"{keys[2]}.html").exists(), "no copy for a link that is not in the library")
        self.assertEqual(self.client.get(f"/archive/{keys[0]}").status_code, 200)
        self.assertEqual(sorted(p.name for p in self.store.iterdir() if p.name.startswith("import.")), [], "temporary upload removed")
        # Importing the same zip again changes nothing.
        again = self._import(data).json
        self.assertEqual((len(again["restored"]), again["already"], again["notInLibrary"]), (0, 2, 1))

    def test_restore_refuses_tampered_or_foreign_files(self):
        import io
        import zipfile
        post = saved_post(45)
        self.http.html("/post/45", "<title>Post 45</title><p>" + "text " * 100 + "</p>")
        self.client.post("/api/library", json={"posts": [post], "deletedUrls": []})
        self.save(post["url"])
        key = archive.copy_key(post["url"])
        page = (self.store / f"{key}.html").read_bytes()
        record = (self.store / f"{key}.json").read_bytes()
        archive.remove(key)

        def bundle(entries):
            buffer = io.BytesIO()
            with zipfile.ZipFile(buffer, "w") as z:
                for name, data in entries:
                    z.writestr(name, data)
            return buffer.getvalue()
        other = archive.copy_key(saved_post(46)["url"])
        cases = {
            "page not written by this app": [(f"copies/{key}.html", b"<!DOCTYPE html><html><script>x()</script></html>"), (f"copies/{key}.json", record)],
            "record for another address": [(f"copies/{other}.html", page), (f"copies/{other}.json", record)],
            "record is not JSON": [(f"copies/{key}.html", page), (f"copies/{key}.json", b"{not json")],
            "page without a record": [(f"copies/{key}.html", page), (f"copies/{other}.json", b"{}")],
        }
        for name, entries in cases.items():
            with self.subTest(case=name):
                result = self._import(bundle([("library.json", b"{}"), *entries])).json  # noqa: E501
                self.assertEqual(result["restored"], [])
                self.assertGreaterEqual(result["invalid"], 1)
        with patch.object(archive, "FILE_LIMIT", 1000):
            result = self._import(bundle([(f"copies/{key}.html", page), (f"copies/{key}.json", record)])).json
            self.assertEqual((result["restored"], result["invalid"]), ([], 1))
        # Names that try to leave the folder are not copies at all and are never written.
        result = self._import(bundle([("library.json", b"{}"), ("../app.py", b"x"), ("copies/../../evil.html", page),
                                      (f"copies/{key}.html/../x.json", record), ("/abs.html", page)])).json
        self.assertEqual((result["restored"], result["invalid"]), ([], 0))
        self.assertEqual(sorted(p.name for p in self.store.iterdir()), [])
        self.assertFalse((ROOT / "evil.html").exists())
        # A page that claims to be ours but was edited: everything outside the allowlist goes.
        planted = page.replace(b"</body>", b'<script>steal()</script><img src="https://tracker.invalid/p.gif" alt="Tracker">'
                               b'<a href="javascript:alert(1)" onclick="x()">click</a><iframe src="https://evil.invalid"></iframe>'
                               b'<form action="https://evil.invalid"><input name="q"></form><div style="background:url(https://evil.invalid/b.png)">bg</div>'
                               b'<video src="https://evil.invalid/v.mp4"></video></body>')
        result = self._import(bundle([(f"copies/{key}.html", planted), (f"copies/{key}.json", record)])).json
        self.assertEqual([item["key"] for item in result["restored"]], [key])
        cleaned = (self.store / f"{key}.html").read_bytes().decode()
        for bad in ("<script", "steal()", "tracker.invalid", "javascript:", "onclick", "<iframe", "<form", "<input", "evil.invalid", "<video"):
            self.assertNotIn(bad, cleaned, bad)
        self.assertIn("[Tracker]", cleaned)
        self.assert_inert(cleaned)
        archive.remove(key)
        # A good entry next to a bad one still restores.
        result = self._import(bundle([(f"copies/{key}.html", page), (f"copies/{key}.json", record),
                                      (f"copies/{other}.html", b"junk"), (f"copies/{other}.json", b"junk")])).json
        self.assertEqual([item["key"] for item in result["restored"]], [key])
        self.assertEqual(result["invalid"], 1)

    def test_restore_request_checks(self):
        self.assertEqual(self._import(b"not a zip at all").status_code, 400)
        self.assertEqual(self._import(b"PK\x03\x04 broken").status_code, 400)
        import io
        import zipfile
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w") as z:
            z.writestr("holiday.jpg", b"x")
        self.assertEqual(self._import(buffer.getvalue()).status_code, 400, "a zip that is not a backup")
        self.assertEqual(self._import(b"{}", content_type="application/json").status_code, 415)
        self.assertEqual(self._import(b"x", content_type="text/plain").status_code, 415)
        for headers in ({"Origin": "http://evil.invalid"}, {"Sec-Fetch-Site": "cross-site"}):
            self.assertEqual(self._import(b"x", headers=headers).status_code, 403)
        with patch.object(archive, "IMPORT_LIMIT", 10):
            self.assertEqual(self._import(b"x" * 11).status_code, 413)
        with patch.object(archive, "ENABLED", False):
            self.assertEqual(self._import(b"x").status_code, 503)
        self.assertEqual(sorted(p.name for p in self.store.iterdir() if p.name.startswith("import.")), [])

    def test_copy_fields_on_a_link_are_validated(self):
        good = saved_post(7, archiveStatus="saved", archivedAt="2026-10-08T10:00:00Z", archiveBytes=12345,
                          archiveKey="0123456789abcdef0123456789abcdef", archiveLimited=True, archiveError="")
        result = self.client.post("/api/library", json={"posts": [good], "deletedUrls": []}).json
        self.assertEqual(result["rejected"], [])
        stored = next(p for p in result["posts"] if p["id"] == good["id"])
        self.assertEqual((stored["archiveStatus"], stored["archiveBytes"], stored["archiveLimited"]), ("saved", 12345, True))
        for number, bad in enumerate(({"archiveStatus": "done"}, {"archiveBytes": -1}, {"archiveBytes": "12"}, {"archiveLimited": "no"},
                                      {"archiveKey": "../../x"}, {"archivedAt": 5}, {"archiveError": ["x"]}), start=20):
            with self.subTest(bad=bad):
                answer = self.client.post("/api/library", json={"posts": [saved_post(number, **bad)], "deletedUrls": []}).json
                self.assertEqual([r["reason"] for r in answer["rejected"]], ["invalid"])


if __name__ == "__main__":
    unittest.main(verbosity=1)
